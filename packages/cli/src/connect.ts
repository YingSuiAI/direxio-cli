import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServiceContext } from "./service-context.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface ConnectRuntimeOptions {
  runner?: CommandRunner;
  binary?: string;
  lines?: number;
  npmBinary?: string;
  npmPackage?: string;
  configFile?: string;
  startupTimeoutMs?: number;
  pollMs?: number;
}

export interface ConnectStatusReport {
  service_id: string;
  status: string;
  work_dir: string | null;
  raw: string;
}

export interface ConnectRestartReport {
  ok: true;
  service_id: string;
  output: string;
}

export interface ConnectInstallReport {
  ok: true;
  service_id: string;
  package: string;
  config: string;
  readiness: string;
}

export interface ConnectConfigInput {
  configFile: string;
  dataDir: string;
  project: string;
  agent: string;
  workspace: string;
  homeserver: string;
  matrixToken: string;
  matrixUser: string;
  roomId: string;
  adminFrom?: string;
  agentCmd?: string;
  agentOptionsToml?: string;
  speech?: {
    enabled?: boolean;
    provider?: string;
    language?: string;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  };
}

const agentErrorPattern =
  /ACP_SESSION_INIT_FAILED|ACP metadata is missing|Recreate this ACP session|failed to create agent|failed to create platform|run_as_user: startup checks failed|CLI not found in PATH|Authentication required|agent login|not logged in|login required|not authenticated|Workspace Trust Required|agent backend offline|agent is offline|agent[^"]*offline|offline[^"]*agent/i;

export async function connectStatus(serviceId: string, options: ConnectRuntimeOptions = {}): Promise<ConnectStatusReport> {
  const result = await runConnect(options, ["daemon", "status", "--service-name", serviceId]);
  return {
    service_id: serviceId,
    status: parseField(result.stdout, "Status") || "Unknown",
    work_dir: parseField(result.stdout, "WorkDir") || null,
    raw: result.stdout
  };
}

export async function connectLogs(serviceId: string, options: ConnectRuntimeOptions = {}): Promise<string> {
  const lines = String(options.lines ?? 120);
  const result = await runConnect(options, ["daemon", "logs", "--service-name", serviceId, "-n", lines]);
  return result.stdout;
}

export async function connectRestart(serviceId: string, options: ConnectRuntimeOptions = {}): Promise<ConnectRestartReport> {
  const result = await runConnect(options, ["daemon", "restart", "--service-name", serviceId]);
  return {
    ok: true,
    service_id: serviceId,
    output: result.stdout
  };
}

export async function connectInstall(
  context: ServiceContext,
  options: ConnectRuntimeOptions = {}
): Promise<ConnectInstallReport> {
  const configFile = options.configFile ?? join(context.serviceDir, "direxio-connect", "config.toml");
  if (!existsSync(configFile)) {
    throw new Error(`direxio-connect config not found for service ${context.serviceId}: ${configFile}`);
  }

  const packageName = connectNpmPackage(options);
  if (shouldInstallConnectPackage(options)) {
    await runCommand(options, options.npmBinary ?? "npm", ["install", "-g", packageName]);
  }
  await runConnect(options, ["daemon", "install", "--config", configFile, "--service-name", context.serviceId, "--force"]);
  const readiness = await waitUntilConnectReady(context.serviceId, options);

  return {
    ok: true,
    service_id: context.serviceId,
    package: packageName,
    config: configFile,
    readiness
  };
}

export function writeConnectConfig(input: ConnectConfigInput): void {
  mkdirSync(dirnamePortable(input.configFile), { recursive: true });
  mkdirSync(input.dataDir, { recursive: true });

  const agentOptionsToml = input.agentOptionsToml?.trim() ?? "";
  const defaultAgentOptionsToml = defaultAgentOptions(input.agent, agentOptionsToml);
  const lines = [
    'language = "zh"',
    `data_dir = "${tomlEscape(input.dataDir)}"`
  ];
  const speechToml = speechConfigToml(input.speech);
  if (speechToml) lines.push("", speechToml);
  lines.push(
    "",
    "[[projects]]",
    `name = "${tomlEscape(input.project)}"`,
    `admin_from = "${tomlEscape(input.adminFrom ?? "")}"`,
    "",
    "[projects.agent]",
    `type = "${tomlEscape(input.agent)}"`,
    "",
    "[projects.agent.options]",
    `work_dir = "${tomlEscape(input.workspace)}"`
  );
  if (input.agentCmd) lines.push(`cmd = "${tomlEscape(input.agentCmd)}"`);
  if (defaultAgentOptionsToml) lines.push(defaultAgentOptionsToml);
  if (agentOptionsToml) lines.push(agentOptionsToml);
  lines.push(
    "",
    "[[projects.platforms]]",
    'type = "matrix"',
    "",
    "[projects.platforms.options]",
    `homeserver = "${tomlEscape(input.homeserver)}"`,
    `access_token = "${tomlEscape(input.matrixToken)}"`,
    `user_id = "${tomlEscape(input.matrixUser)}"`,
    `room_id = "${tomlEscape(input.roomId)}"`,
    "share_session_in_channel = true",
    "group_reply_all = true",
    "auto_join = false",
    "auto_verify = false"
  );
  writeFileSync(input.configFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

export const defaultRunner: CommandRunner = (command, args) => {
  return new Promise((resolve) => {
    const executable = resolveExecutable(command);
    const child = spawn(executable, args, {
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
      windowsHide: true
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1
      });
    });
    child.on("error", (error) => {
      resolve({
        stdout: "",
        stderr: error.message,
        exitCode: 1
      });
    });
  });
};

function resolveExecutable(command: string): string {
  if (process.platform !== "win32" || /[\\/]/.test(command)) return command;
  const lookup = spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true });
  if (lookup.status !== 0 || !lookup.stdout.trim()) return command;
  const candidates = lookup.stdout.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((candidate) => /\.(?:exe|cmd|bat|com)$/i.test(candidate)) ?? candidates[0] ?? command;
}

function shouldInstallConnectPackage(options: ConnectRuntimeOptions): boolean {
  if (options.runner) return true;
  if (process.env.DIREXIO_CONNECT_FORCE_NPM_INSTALL === "1") return true;
  return !commandExists(options.binary ?? "direxio-connect");
}

function commandExists(command: string): boolean {
  if (/[\\/]/.test(command)) return existsSync(command);
  if (process.platform === "win32") {
    return spawnSync("where.exe", [command], { windowsHide: true }).status === 0;
  }
  return spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], { windowsHide: true }).status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runConnect(options: ConnectRuntimeOptions, args: string[]): Promise<CommandResult> {
  return runCommand(options, options.binary ?? "direxio-connect", args);
}

async function runCommand(options: ConnectRuntimeOptions, command: string, args: string[]): Promise<CommandResult> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.exitCode}`).trim());
  }
  return result;
}

async function waitUntilConnectReady(serviceId: string, options: ConnectRuntimeOptions): Promise<string> {
  const timeoutMs = options.startupTimeoutMs ?? envSeconds("DIREXIO_CONNECT_STARTUP_TIMEOUT_SECONDS", 30) * 1000;
  const pollMs = options.pollMs ?? Math.max(envSeconds("DIREXIO_CONNECT_STARTUP_POLL_SECONDS", 2) * 1000, 1);
  let elapsed = 0;

  while (true) {
    const status = await connectStatus(serviceId, options);
    if (status.status !== "Running") {
      throw new Error("daemon status is not Running");
    }

    const logs = await connectLogs(serviceId, {
      ...options,
      lines: options.lines ?? envInteger("DIREXIO_CONNECT_LOG_TAIL_LINES", 120)
    });
    const agentError = connectDaemonAgentErrorFromText(logs);
    if (agentError) {
      throw new Error(`local agent backend failure: ${agentError}`);
    }
    const ready = connectDaemonReadyFromText(logs);
    if (ready) return ready;

    if (elapsed >= timeoutMs) {
      throw new Error(`startup logs did not show 'direxio-connect is running' within ${Math.ceil(timeoutMs / 1000)}s`);
    }
    await sleep(pollMs);
    elapsed += pollMs;
  }
}

function connectDaemonAgentErrorFromText(text: string): string {
  return agentErrorPattern.exec(recentConnectLogs(text))?.[0] ?? "";
}

function connectDaemonReadyFromText(text: string): string {
  return /direxio-connect is running/i.exec(recentConnectLogs(text))?.[0] ?? "";
}

function recentConnectLogs(text: string): string {
  let buffer = "";
  for (const line of text.split(/\r?\n/)) {
    if (/config loaded|direxio-connect is running|acquired instance lock/i.test(line)) {
      buffer = "";
    }
    buffer += `${line}\n`;
  }
  return buffer;
}

function connectNpmPackage(options: ConnectRuntimeOptions): string {
  return options.npmPackage ?? process.env.DIREXIO_CONNECT_NPM_PACKAGE ?? "direxio-connent@latest";
}

function envInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envSeconds(name: string, fallback: number): number {
  return envInteger(name, fallback);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseField(text: string, field: string): string {
  const pattern = new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "im");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}

function defaultAgentOptions(agent: string, explicitToml: string): string {
  if (agent !== "codex") return "";
  const lines = [];
  if (!tomlHasKey(explicitToml, "backend")) lines.push('backend = "app_server"');
  if (!tomlHasKey(explicitToml, "app_server_url")) lines.push('app_server_url = "stdio"');
  if (!tomlHasKey(explicitToml, "mode")) lines.push('mode = "yolo"');
  return lines.join("\n");
}

function speechConfigToml(speech?: ConnectConfigInput["speech"]): string {
  if (!speech?.enabled && !speech?.apiKey) return "";
  const lines = [
    "[speech]",
    "enabled = true",
    `provider = "${tomlEscape(speech.provider ?? "openai")}"`,
    `language = "${tomlEscape(speech.language ?? "zh")}"`
  ];
  if (speech.apiKey || speech.baseUrl || speech.model) {
    lines.push("", "[speech.openai]");
    if (speech.apiKey) lines.push(`api_key = "${tomlEscape(speech.apiKey)}"`);
    if (speech.baseUrl) lines.push(`base_url = "${tomlEscape(speech.baseUrl)}"`);
    if (speech.model) lines.push(`model = "${tomlEscape(speech.model)}"`);
  }
  return lines.join("\n");
}

function tomlHasKey(toml: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(toml);
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function dirnamePortable(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : ".";
}
