import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ServiceContext } from "./service-context.js";

export type ServiceState = Record<string, any>;

export interface ConfirmOptions {
  now?: () => string;
  runtimeProbeConfirmed?: boolean;
}

export interface ConfirmResult {
  gate: string;
  status: "confirmed";
  ts: string;
}

const confirmationGates = new Set(["app_initialization", "real_chat", "agent_mcp_runtime"]);

export function serviceStateFile(context: ServiceContext): string {
  return join(context.serviceDir, "state.json");
}

export function readServiceState(context: ServiceContext): ServiceState {
  const file = serviceStateFile(context);
  if (!existsSync(file)) {
    throw new Error(`state.json not found for service ${context.serviceId}: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as ServiceState;
}

export function writeServiceState(context: ServiceContext, state: ServiceState): void {
  const file = serviceStateFile(context);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function confirmUserGate(
  context: ServiceContext,
  rawGate: string,
  evidence: string,
  options: ConfirmOptions = {}
): ConfirmResult {
  const gate = normalizeGate(rawGate);
  if (!confirmationGates.has(gate)) {
    throw new Error("confirm requires app-initialization, real-chat, or agent-mcp-runtime");
  }
  if (!evidence.trim() || evidence.trim().length < 12) {
    throw new Error("confirm requires concrete evidence of at least 12 characters");
  }

  const state = readServiceState(context);
  if (gate === "agent_mcp_runtime") {
    const summaryStatus = state.runtime_checks?.summary?.status ?? "not_run";
    if (summaryStatus !== "passed") {
      throw new Error("agent-mcp-runtime confirmation requires runtime_checks.summary.status=passed");
    }
    if (options.runtimeProbeConfirmed !== true) {
      throw new Error("agent-mcp-runtime confirmation requires runtimeProbeConfirmed=true");
    }
  }

  const ts = options.now?.() ?? new Date().toISOString();
  if (!isObject(state.user_confirmations)) state.user_confirmations = {};
  state.user_confirmations[gate] = {
    status: "confirmed",
    ts,
    evidence: evidence.trim(),
    ...(gate === "agent_mcp_runtime"
      ? {
          runtime_summary_status: state.runtime_checks?.summary?.status ?? "",
          runtime_probe_confirmed: true
        }
      : {})
  };
  writeServiceState(context, state);
  return { gate, status: "confirmed", ts };
}

export function buildOperationReport(
  operation: string,
  status: string,
  stateFile: string,
  generatedAt: string,
  st: ServiceState
): any {
  const redactedStatus = stringValue(st.password).length > 0 ? "available_in_state_password_field_redacted" : "missing";
  const phaseStatuses: Record<string, string> = {};
  for (const [key, value] of Object.entries(objectValue(st.phases))) {
    phaseStatuses[key] = stringValue((value as any)?.status || "unknown");
  }
  const userGate = (gate: string, fallback: string) => st.user_confirmations?.[gate]?.status || fallback;
  const localRefreshStatus = st.connect_install_status === "refresh_pending" ? "refresh_pending" : "current_or_not_recorded";
  const billable = compact([
    stringValue(st.resources?.instance_id) ? `EC2 ${st.resources.instance_id}` : "",
    stringValue(st.resources?.root_volume_id) ? `EBS root volume ${st.resources.root_volume_id}` : "",
    stringValue(st.resources?.public_ip) ? `public IPv4 ${st.resources.public_ip}` : "",
    stringValue(st.resources?.eip_id) ? `Elastic IP ${st.resources.eip_id}` : "",
    stringValue(st.resources?.route53_zone_id) ? `Route53 hosted zone ${st.resources.route53_zone_id}` : ""
  ]);
  const destroyStatus = (key: string) => st.destroy_evidence?.[key]?.status || "not_checked";
  const statusNotIn = (value: string, safe: string[]) => !safe.includes(value);
  const destroyBillableResidue = compact([
    stringValue(st.resources?.instance_id) && statusNotIn(destroyStatus("ec2_instance"), ["terminated", "not_found", "skipped"])
      ? `EC2 ${st.resources.instance_id} status=${destroyStatus("ec2_instance")}` : "",
    stringValue(st.resources?.root_volume_id) && statusNotIn(destroyStatus("ebs_root_volume"), ["deleted", "skipped"])
      ? `EBS root volume ${st.resources.root_volume_id} status=${destroyStatus("ebs_root_volume")}` : "",
    stringValue(st.resources?.eip_id) && statusNotIn(destroyStatus("elastic_ip"), ["released", "skipped"])
      ? `Elastic IP ${st.resources.eip_id} status=${destroyStatus("elastic_ip")}` : "",
    stringValue(st.resources?.route53_zone_id) && statusNotIn(destroyStatus("route53_hosted_zone"), ["deleted", "skipped"])
      ? `Route53 hosted zone ${st.resources.route53_zone_id} status=${destroyStatus("route53_hosted_zone")}` : ""
  ]);

  const report: any = {
    operation_type: operation,
    status,
    generated_at: generatedAt,
    domain: st.domain || "",
    service_id: st.agent_service_id || st.domain || "",
    service_dir: st.agent_service_dir || "",
    state_json: stateFile,
    delivery: {
      app_domain: st.domain || "",
      product_completion_status: status,
      init_code_status: redactedStatus,
      init_code_secret_redacted: true,
      user_path: "enter app_domain and the eight-digit initialization code in the App"
    },
    agent: {
      node_id: st.agent_node_id || "",
      room_id: st.agent_room_id || "",
      runtime: st.agent_runtime || "unknown",
      service_id: st.agent_service_id || st.domain || "",
      credentials_file: st.agent_credentials_file || ""
    },
    gates: {
      automated: phaseStatuses,
      user_confirmation: {
        app_initialization: userGate("app_initialization", "pending_user_confirmation"),
        real_chat: userGate("real_chat", "pending_user_confirmation"),
        agent_mcp_runtime: userGate("agent_mcp_runtime", "pending_runtime_confirmation")
      },
      user_confirmation_details: {
        app_initialization: userGateDetail(st, "app_initialization", "pending_user_confirmation"),
        real_chat: userGateDetail(st, "real_chat", "pending_user_confirmation"),
        agent_mcp_runtime: userGateDetail(st, "agent_mcp_runtime", "pending_runtime_confirmation")
      }
    },
    runtime_checks: {
      summary: st.runtime_checks?.summary || { status: "not_run" },
      connect_daemon: st.runtime_checks?.connect_daemon || { status: "not_run" },
      mcp_doctor: st.runtime_checks?.mcp_doctor || { status: "not_run" },
      mcp_smoke: st.runtime_checks?.mcp_smoke || { status: "not_run" },
      mcp_tools: st.runtime_checks?.mcp_tools || { status: "not_run" }
    },
    credentials: {
      status: localRefreshStatus,
      credentials_file: st.agent_credentials_file || "",
      contains_secrets: true,
      values_redacted: true
    },
    connect: {
      package: st.connect_npm_package || "direxio-connent@latest",
      agent: st.connect_agent || "",
      config: st.connect_config || "",
      install_status: st.connect_install_status || ""
    },
    mcp: {
      status: localRefreshStatus,
      install_status: st.mcp_install_status || "",
      package: st.mcp_npm_package || "direxio-mcp@latest",
      server_name: st.mcp_server_name || "",
      config_dir: st.mcp_config_dir || "",
      codex: st.mcp_codex_config || "",
      openclaw: st.mcp_openclaw_config || "",
      hermes: st.mcp_hermes_config || "",
      doctor: st.mcp_doctor_command || "",
      daemon_install_status: st.mcp_daemon_install_status || "",
      daemon_url: st.mcp_daemon_url || "",
      daemon_status: st.mcp_daemon_status_command || "",
      daemon_proxy: st.mcp_daemon_proxy_command || ""
    },
    resources: {
      region: st.region || "",
      domain_mode: st.domain_mode || "",
      instance_type: st.instance_type || "",
      instance_id: st.resources?.instance_id || "",
      root_volume_id: st.resources?.root_volume_id || "",
      public_ip: st.resources?.public_ip || "",
      eip_id: st.resources?.eip_id || "",
      route53_zone_id: st.resources?.route53_zone_id || "",
      route53_zone_name: st.resources?.route53_zone_name || "",
      route53_zone_created_by_deployer: st.resources?.route53_zone_created_by_deployer || "",
      route53_existing_a_value: st.resources?.route53_existing_a_value || "",
      route53_pending_a_value: st.resources?.route53_pending_a_value || "",
      route53_overwrite_confirmed: st.resources?.route53_overwrite_confirmed || "",
      sg_id: st.resources?.sg_id || "",
      key_name: st.resources?.key_name || ""
    },
    billing: {
      keeps_billing_until_destroy: operation !== "destroy",
      recorded_billable_resources: billable,
      cost_estimate: typeof st.cost_estimate === "undefined" ? null : st.cost_estimate,
      destroy_cleanup_status: operation !== "destroy"
        ? "not_destroy"
        : destroyBillableResidue.length === 0
          ? "no_recorded_billable_resource_residue"
          : "possible_billable_resource_residue",
      possible_remaining_billable_resources: operation === "destroy" ? destroyBillableResidue : []
    },
    security: {
      secrets_included: false,
      values_redacted: true,
      root_access_key_allowed: true,
      temporary_iam_cleanup_required: true,
      temporary_iam_cleanup_action: "if a temporary DirexioDeployer access key was used, delete or disable it after deployment, or reduce it to a maintenance-only policy"
    }
  };

  if (operation === "destroy") {
    report.destroy = {
      resources_processed_from_state: true,
      user_managed_dns_not_removed: true,
      purchased_domain_not_removed: true,
      local_service_dir: st.agent_service_dir || "",
      evidence: st.destroy_evidence || {}
    };
  }

  return report;
}

export function buildStatusReport(context: ServiceContext, generatedAt: string = new Date().toISOString()): any {
  const stateFile = serviceStateFile(context);
  const state = readServiceState(context);
  return buildOperationReport("status", "status_report", stateFile, generatedAt, state);
}

export function operationReportFile(context: ServiceContext): string {
  return join(context.serviceDir, "operation-report.json");
}

export function writeOperationReport(
  context: ServiceContext,
  operation: string,
  status: string,
  state: ServiceState = readServiceState(context),
  generatedAt: string = new Date().toISOString()
): string {
  const reportPath = operationReportFile(context);
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = buildOperationReport(operation, status, serviceStateFile(context), generatedAt, state);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function normalizeGate(rawGate: string): string {
  return rawGate.trim().replace(/-/g, "_");
}

function userGateDetail(st: ServiceState, gate: string, fallback: string): any {
  const gateState = st.user_confirmations?.[gate] || {};
  const originalEvidence = stringValue(gateState.evidence);
  const evidence = redactText(originalEvidence, st);
  const detail: any = {
    status: gateState.status || fallback,
    ts: gateState.ts || "",
    evidence,
    evidence_redacted: evidence !== originalEvidence
  };
  if (gate === "agent_mcp_runtime") {
    detail.runtime_summary_status = gateState.runtime_summary_status || "";
    detail.runtime_probe_confirmed = gateState.runtime_probe_confirmed || false;
  }
  return detail;
}

function redactText(value: string, st: ServiceState): string {
  let result = stringValue(value);
  for (const secret of [
    st.password,
    st.access_token,
    st.agent_token,
    st.matrix_access_token,
    st.owner_access_token,
    st.aws_secret_access_key,
    st.aws_session_token
  ]) {
    const text = stringValue(secret);
    if (text.length > 0) result = result.split(text).join("<redacted>");
  }
  return result.replace(/[0-9]{8,}/g, "<redacted>");
}

function stringValue(value: unknown): string {
  if (value === null || typeof value === "undefined") return "";
  return String(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function compact(values: string[]): string[] {
  return values.filter((value) => value.length > 0);
}
