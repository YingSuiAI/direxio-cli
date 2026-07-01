import { dirname, join, normalize } from "node:path";
import { connectLogs, connectStatus, type CommandRunner } from "./connect.js";
import { callMcpTool, createDoctorReport, listMcpTools } from "./mcp.js";
import { loadServiceConfigFromContext, type ServiceContext } from "./service-context.js";
import { readServiceState, writeServiceState, type ServiceState } from "./state.js";

export interface RuntimeVerifyOptions {
  runner?: CommandRunner;
  fetch?: typeof fetch;
  now?: () => string;
}

export interface RuntimeVerifySummary {
  status: "passed" | "failed";
  failed_count: number;
  checks: Record<string, string>;
}

const agentErrorPattern =
  /ACP_SESSION_INIT_FAILED|ACP metadata is missing|Recreate this ACP session|failed to create agent|failed to create platform|run_as_user: startup checks failed|CLI not found in PATH|Authentication required|agent login|not logged in|login required|not authenticated|Workspace Trust Required|agent backend offline|agent is offline|agent[^"]*offline|offline[^"]*agent/i;

export async function verifyRuntime(
  context: ServiceContext,
  options: RuntimeVerifyOptions = {}
): Promise<RuntimeVerifySummary> {
  const state = readServiceState(context);
  const now = options.now?.() ?? new Date().toISOString();

  await recordCheck(state, "connect_daemon", () => verifyConnectDaemon(context, state, options, now), now);
  await recordCheck(state, "mcp_doctor", () => verifyMcpDoctor(context, state, now), now);
  await recordCheck(state, "mcp_tools", () => verifyMcpTools(state, now), now);
  await recordCheck(state, "mcp_smoke", () => verifyMcpSmoke(context, state, options, now), now);

  const checks = {
    connect_daemon: checkStatus(state, "connect_daemon"),
    mcp_doctor: checkStatus(state, "mcp_doctor"),
    mcp_tools: checkStatus(state, "mcp_tools"),
    mcp_smoke: checkStatus(state, "mcp_smoke")
  };
  const failedCount = Object.values(checks).filter(runtimeStatusCountsAsFailure).length;
  const summary: RuntimeVerifySummary = {
    status: failedCount === 0 ? "passed" : "failed",
    failed_count: failedCount,
    checks
  };
  state.runtime_checks.summary = {
    ...summary,
    ts: now,
    evidence: failedCount === 0 ? "all runtime checks passed" : "one or more runtime checks failed"
  };
  writeServiceState(context, state);
  return summary;
}

async function verifyConnectDaemon(
  context: ServiceContext,
  state: ServiceState,
  options: RuntimeVerifyOptions,
  now: string
): Promise<void> {
  if (state.connect_install_status === "recommend" || state.connect_install_status === "skip") {
    state.runtime_checks.connect_daemon = {
      status: "manual_pending",
      ts: now,
      evidence: `direxio-connect daemon install is an explicit operator action for policy=${state.connect_install_status}`,
      service_name: connectServiceName(context, state)
    };
    return;
  }

  const serviceName = connectServiceName(context, state);
  const expectedWorkDir = connectExpectedWorkDir(context, state);
  const binary = state.connect_binary || "direxio-connect";
  const status = await connectStatus(serviceName, { runner: options.runner, binary });
  let evidence = "";
  if (status.status !== "Running") {
    evidence = "direxio-connect daemon is not Running";
  } else if (!status.work_dir) {
    evidence = "direxio-connect daemon status has no WorkDir";
  } else if (!pathsEqual(status.work_dir, expectedWorkDir)) {
    evidence = "direxio-connect daemon belongs to a different service";
  }

  if (evidence) {
    state.runtime_checks.connect_daemon = {
      status: "failed",
      ts: now,
      evidence,
      service_name: serviceName,
      daemon_status: status.status,
      work_dir: status.work_dir ?? "",
      expected_work_dir: expectedWorkDir
    };
    return;
  }

  const logs = await connectLogs(serviceName, { runner: options.runner, binary, lines: 120 });
  const agentError = connectDaemonAgentErrorFromText(logs);
  if (agentError) {
    state.runtime_checks.connect_daemon = {
      status: "failed",
      ts: now,
      evidence: "direxio-connect daemon logs report local agent backend failure",
      service_name: serviceName,
      daemon_status: status.status,
      work_dir: status.work_dir,
      expected_work_dir: expectedWorkDir,
      agent_error: agentError
    };
    return;
  }

  state.runtime_checks.connect_daemon = {
    status: "passed",
    ts: now,
    evidence: "direxio-connect daemon is running for this service",
    service_name: serviceName,
    daemon_status: status.status,
    work_dir: status.work_dir,
    expected_work_dir: expectedWorkDir
  };
}

function verifyMcpDoctor(context: ServiceContext, state: ServiceState, now: string): void {
  const config = loadServiceConfigFromContext(context);
  const report = createDoctorReport(config);
  state.runtime_checks.mcp_doctor = {
    status: "passed",
    ts: now,
    evidence: "direxio mcp doctor succeeded",
    domain: report.domain,
    agent_room_id: report.agent_room_id,
    token: "present_redacted"
  };
}

function verifyMcpTools(state: ServiceState, now: string): void {
  const tools = listMcpTools();
  state.runtime_checks.mcp_tools = {
    status: "passed",
    ts: now,
    evidence: "MCP tools/list succeeded",
    tool_count: tools.length,
    tools
  };
}

async function verifyMcpSmoke(
  context: ServiceContext,
  state: ServiceState,
  options: RuntimeVerifyOptions,
  now: string
): Promise<void> {
  const config = loadServiceConfigFromContext(context);
  const response = await callMcpTool(config, "list_messages", {}, options.fetch ?? fetch);
  if (!Array.isArray(response.messages) || typeof response.room_id !== "string") {
    throw new Error("mcp.messages.list returned invalid response");
  }
  state.runtime_checks.mcp_smoke = {
    status: "passed",
    ts: now,
    action: "mcp.messages.list",
    room_id: config.agentRoomId ?? "",
    response_room_id: response.room_id,
    response_messages_type: "array",
    evidence: "read-only backend smoke check succeeded"
  };
}

async function recordCheck(
  state: ServiceState,
  name: string,
  run: () => Promise<void> | void,
  now: string
): Promise<void> {
  if (!state.runtime_checks || typeof state.runtime_checks !== "object") {
    state.runtime_checks = {};
  }
  try {
    await run();
  } catch (error) {
    state.runtime_checks[name] = {
      status: "failed",
      ts: now,
      evidence: error instanceof Error ? error.message : String(error)
    };
  }
}

function connectServiceName(context: ServiceContext, state: ServiceState): string {
  return state.agent_service_id || state.domain || context.serviceId || "direxio-connect";
}

function connectExpectedWorkDir(context: ServiceContext, state: ServiceState): string {
  if (state.connect_config) return dirname(String(state.connect_config));
  if (state.connect_runtime_dir) return String(state.connect_runtime_dir);
  if (state.agent_service_dir) return join(String(state.agent_service_dir), "direxio-connect");
  return join(context.serviceDir, "direxio-connect");
}

function checkStatus(state: ServiceState, check: string): string {
  return state.runtime_checks?.[check]?.status || "not_run";
}

function runtimeStatusCountsAsFailure(status: string): boolean {
  return !["passed", "manual_pending", "skipped"].includes(status);
}

function connectDaemonAgentErrorFromText(text: string): string {
  return agentErrorPattern.exec(recentConnectLogs(text))?.[0] ?? "";
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

function pathsEqual(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(value: string): string {
  const normalized = normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
