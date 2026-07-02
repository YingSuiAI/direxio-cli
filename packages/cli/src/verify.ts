import { dirname, join, normalize } from "node:path";
import { checkAgentProvider } from "./agents/check.js";
import { connectLogs, connectStatus, type CommandRunner } from "./connect.js";
import { callMcpTool, createDoctorReport, listMcpTools, mcpDaemonStatus } from "./mcp.js";
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

  await recordCheck(state, "agent_provider", () => verifyAgentProvider(state, options, now), now);
  await recordCheck(state, "connect_daemon", () => verifyConnectDaemon(context, state, options, now), now);
  await recordCheck(state, "mcp_daemon", () => verifyMcpDaemon(context, state, options, now), now);
  await recordCheck(state, "mcp_doctor", () => verifyMcpDoctor(context, state, now), now);
  await recordCheck(state, "mcp_tools", () => verifyMcpTools(state, now), now);
  await recordCheck(state, "mcp_smoke", () => verifyMcpSmoke(context, state, options, now), now);

  const checks = {
    agent_provider: checkStatus(state, "agent_provider"),
    connect_daemon: checkStatus(state, "connect_daemon"),
    mcp_daemon: checkStatus(state, "mcp_daemon"),
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

async function verifyAgentProvider(state: ServiceState, options: RuntimeVerifyOptions, now: string): Promise<void> {
  const report = await checkAgentProvider(String(state.connect_provider || state.agent_runtime || state.connect_agent || "codex"), {
    runner: options.runner
  });
  state.runtime_checks.agent_provider = {
    ...report,
    ts: now,
    evidence: report.status === "passed" ? "selected agent provider dependencies are available" : "selected agent provider dependencies are missing"
  };
}

async function verifyConnectDaemon(
  context: ServiceContext,
  state: ServiceState,
  options: RuntimeVerifyOptions,
  now: string
): Promise<void> {
  if (localInstallIsManual(state, state.connect_install_status)) {
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

async function verifyMcpDaemon(
  context: ServiceContext,
  state: ServiceState,
  options: RuntimeVerifyOptions,
  now: string
): Promise<void> {
  if (localInstallIsManual(state, state.mcp_install_status)) {
    state.runtime_checks.mcp_daemon = {
      status: state.mcp_install_status === "skipped" || state.mcp_daemon_install_status === "skipped" ? "skipped" : "manual_pending",
      ts: now,
      evidence: `direxio-mcp daemon install is an explicit operator action for policy=${state.local_install_mode || state.mcp_install_status || "unknown"}`,
      service_name: context.serviceId
    };
    return;
  }

  const report = await mcpDaemonStatus(context.serviceId, { runner: options.runner, binary: state.mcp_command || "direxio-mcp" });
  const status = String(report.status ?? report.Status ?? report.state ?? report.daemon_status ?? "").toLowerCase();
  const ok = report.ok === true || ["running", "ready", "ok", "installed"].includes(status);
  if (!ok) {
    state.runtime_checks.mcp_daemon = {
      status: "failed",
      ts: now,
      evidence: "direxio-mcp daemon status is not ready",
      service_name: context.serviceId,
      daemon_status: status || "unknown"
    };
    return;
  }

  state.runtime_checks.mcp_daemon = {
    status: "passed",
    ts: now,
    evidence: "direxio-mcp daemon is ready for this service",
    service_name: context.serviceId,
    daemon_status: status || "ok"
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

function localInstallIsManual(state: ServiceState, status: unknown): boolean {
  return ["recommend", "skip"].includes(String(state.local_install_mode || ""))
    || ["recommend", "recommended", "skip", "skipped"].includes(String(status || ""));
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
