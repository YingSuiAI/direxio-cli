import { dirname, join, normalize } from "node:path";
import { connectStatus, defaultRunner, type CommandRunner } from "./connect.js";
import type { ServiceContext } from "./service-context.js";
import { readServiceState, writeOperationReport, writeServiceState, type ServiceState } from "./state.js";

export interface OpsOptions {
  runner?: CommandRunner;
  now?: () => string;
  messageServerImage?: string;
  confirm?: boolean;
}

export interface OperationResult {
  ok: true;
  operation: "update" | "reset_app_data";
  report: string;
}

export async function updateService(context: ServiceContext, options: OpsOptions = {}): Promise<OperationResult> {
  const state = readServiceState(context);
  await runRemoteCommand(state, buildUpdateRemoteCommand(options.messageServerImage), options);
  const report = writeOperationReport(
    context,
    "update",
    "update_remote_restart_complete",
    state,
    options.now?.() ?? new Date().toISOString()
  );
  return { ok: true, operation: "update", report };
}

export async function resetAppData(context: ServiceContext, options: OpsOptions = {}): Promise<OperationResult> {
  if (options.confirm !== true) {
    throw new Error("reset-app-data requires confirm=true");
  }
  const state = readServiceState(context);
  await runRemoteCommand(state, buildResetRemoteCommand(), options);
  await stopScopedConnectDaemon(context, state, options);
  markRefreshPending(state, options.now?.() ?? new Date().toISOString());
  writeServiceState(context, state);
  const report = writeOperationReport(
    context,
    "reset_app_data",
    "reset_remote_data_cleared_refresh_pending",
    state,
    options.now?.() ?? new Date().toISOString()
  );
  return { ok: true, operation: "reset_app_data", report };
}

async function runRemoteCommand(state: ServiceState, remoteCommand: string, options: OpsOptions): Promise<void> {
  const keyFile = stringValue(state.resources?.key_file);
  const publicIp = stringValue(state.resources?.public_ip);
  if (!keyFile || !publicIp) {
    throw new Error("state is missing resources.key_file or resources.public_ip; cannot SSH to existing EC2");
  }
  await runCommand(options, "ssh", [
    "-i",
    keyFile,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    `ubuntu@${publicIp}`,
    remoteCommand
  ]);
}

async function stopScopedConnectDaemon(context: ServiceContext, state: ServiceState, options: OpsOptions): Promise<void> {
  const binary = stringValue(state.connect_binary) || "direxio-connect";
  const serviceName = connectServiceName(context, state);
  const expectedWorkDir = connectExpectedWorkDir(context, state);
  try {
    const status = await connectStatus(serviceName, { runner: options.runner, binary });
    if (status.status === "Running" && status.work_dir && pathsEqual(status.work_dir, expectedWorkDir)) {
      await runCommand(options, binary, ["daemon", "stop", "--service-name", serviceName]);
    }
  } catch {
    return;
  }
}

async function runCommand(options: OpsOptions, command: string, args: string[]): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.exitCode}`).trim());
  }
}

function buildUpdateRemoteCommand(image?: string): string {
  const remoteScript = `set -eu
cd /var/direxio-message-server
if [ -n "\${MESSAGE_SERVER_IMAGE:-}" ]; then
  IMAGE=$MESSAGE_SERVER_IMAGE
  escaped_image=$(printf '%s\n' "$IMAGE" | sed 's/[\\/&]/\\\\&/g')
  if grep -q '^MESSAGE_SERVER_IMAGE=' .env; then
    sed -i "s#^MESSAGE_SERVER_IMAGE=.*#MESSAGE_SERVER_IMAGE=$escaped_image#" .env
  else
    printf 'MESSAGE_SERVER_IMAGE=%s\n' "$IMAGE" | tee -a .env >/dev/null
  fi
fi
docker compose --env-file .env pull
docker compose --env-file .env up -d
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
BOOTSTRAP_FILE=/var/direxio-message-server/p2p/bootstrap.json
if [ -s "$BOOTSTRAP_FILE" ]; then
  echo "[update] existing bootstrap credentials are present; skipping portal.bootstrap."
else
  DOMAIN="$DOMAIN" bash /var/direxio-message-server/init-tokens.sh
fi`;
  if (image) return `sudo MESSAGE_SERVER_IMAGE=${shellQuote(image)} sh -lc ${shellQuote(remoteScript)}`;
  return `sudo sh -lc ${shellQuote(remoteScript)}`;
}

function buildResetRemoteCommand(): string {
  const remoteScript = `set -eu
cd /var/direxio-message-server
sudo docker compose --env-file .env down
project=$(basename "$PWD")
for volume in postgres-data message-config message-data; do
  ids=$(sudo docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.volume=$volume" 2>/dev/null || true)
  if [ -n "$ids" ]; then
    sudo docker volume rm $ids >/dev/null 2>&1 || true
  fi
  sudo docker volume rm "\${project}_\${volume}" >/dev/null 2>&1 || true
done
sudo rm -f /var/direxio-message-server/p2p/bootstrap.json
new_code=$(od -An -N4 -tu4 /dev/urandom | awk '{printf "%08d", $1 % 100000000}')
sudo sed -i '/^P2P_PORTAL_PASSWORD=/d' .env
printf 'P2P_PORTAL_PASSWORD=%s\n' "$new_code" | sudo tee -a .env >/dev/null
sudo docker compose --env-file .env up -d
DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2)
DOMAIN="$DOMAIN" bash /var/direxio-message-server/init-tokens.sh`;
  return `sudo sh -lc ${shellQuote(remoteScript)}`;
}

function markRefreshPending(state: ServiceState, ts: string): void {
  for (const key of ["password", "access_token", "agent_token", "agent_room_id", "user_confirmations", "runtime_checks"]) {
    delete state[key];
  }
  state.connect_install_status = "refresh_pending";
  state.mcp_install_status = "refresh_pending";
  state.mcp_daemon_install_status = "refresh_pending";
  state.phase = "S5_INIT_TOKENS";
  if (!state.phases || typeof state.phases !== "object") state.phases = {};
  state.phases.S5_INIT_TOKENS = {
    status: "pending",
    ts,
    evidence: "existing node operation requires fresh bootstrap credentials"
  };
  state.phases.S6_WIRE_LOCAL = {
    status: "pending",
    ts,
    evidence: "existing node operation requires local credentials and MCP refresh"
  };
  state.phases.S7_VERIFY_E2E = {
    status: "pending",
    ts,
    evidence: "existing node operation requires fresh verification"
  };
}

function connectServiceName(context: ServiceContext, state: ServiceState): string {
  return stringValue(state.agent_service_id) || stringValue(state.domain) || context.serviceId || "direxio-connect";
}

function connectExpectedWorkDir(context: ServiceContext, state: ServiceState): string {
  if (state.connect_config) return dirname(String(state.connect_config));
  if (state.connect_runtime_dir) return String(state.connect_runtime_dir);
  if (state.agent_service_dir) return join(String(state.agent_service_dir), "direxio-connect");
  return join(context.serviceDir, "direxio-connect");
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(value: string): string {
  const normalized = normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function stringValue(value: unknown): string {
  if (value === null || typeof value === "undefined") return "";
  return String(value);
}
