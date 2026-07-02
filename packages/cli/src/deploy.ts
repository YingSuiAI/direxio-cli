import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { promises as dnsPromises } from "node:dns";
import { resolveAgentProvider } from "./agents/registry.js";
import type { AgentProvider } from "./agents/types.js";
import { renderCloudInitUserData } from "./cloud-init.js";
import { connectInstall, defaultRunner, writeConnectConfig, type CommandResult, type CommandRunner } from "./connect.js";
import { installMcpTarget, writeMcpTargetArtifacts } from "./mcp-config.js";
import type { ServiceConfig, ServiceContext } from "./service-context.js";
import { readServiceState, serviceStateFile, writeOperationReport, writeServiceState, type ServiceState } from "./state.js";
import { verifyRuntime } from "./verify.js";

export interface DeployOptions {
  homeDir?: string;
  serviceId: string;
  domain: string;
  region: string;
  domainMode?: DomainMode;
  agent?: string;
  agentInstallMode?: AgentInstallMode;
  mcpTarget?: string;
  workspace?: string;
  confirmDomainBinding: boolean;
  confirmDnsOverwrite?: boolean;
  runner?: CommandRunner;
  fetch?: typeof fetch;
  dnsResolver?: DnsResolver;
  now?: () => string;
}

export type DomainMode = "auto" | "user" | "route53";
export type AgentInstallMode = "auto" | "recommend" | "skip";

export interface DnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolveNs?: (domain: string) => Promise<string[]>;
  resolve4At?: (server: string, domain: string) => Promise<string[]>;
}

export interface DeployResult {
  ok: true;
  service_id: string;
  domain: string;
  state: string;
  report: string;
}

export class WaitingForUserAction extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "WaitingForUserAction";
  }
}

interface BootstrapCredentials {
  password: string;
  access_token: string;
  agent_token: string;
  agent_room_id: string;
}

interface MatrixSession {
  access_token: string;
  device_id: string;
  user_id: string;
  homeserver: string;
}

const DEFAULT_ROOT_VOLUME_GB = 50;
const DEFAULT_ROOT_DEVICE_NAME = "/dev/sda1";

const phases = [
  "S0_PREREQ_AWS",
  "S1_PREFLIGHT",
  "S2_DOMAIN",
  "S3_PROVISION",
  "S4_BOOTSTRAP_STACK",
  "S5_INIT_TOKENS",
  "S6_WIRE_LOCAL",
  "S7_VERIFY_E2E"
];

export async function deployService(options: DeployOptions): Promise<DeployResult> {
  const serviceId = options.serviceId.trim();
  const domain = normalizeDomainName(options.domain);
  const region = options.region.trim();
  if (!serviceId) throw new Error("deploy requires serviceId");
  if (!domain) throw new Error("deploy requires domain");
  if (!region) throw new Error("deploy requires region");
  if (!options.confirmDomainBinding) {
    throw new Error("deploy requires confirmed domain binding");
  }
  const agentProvider = await resolveAgentProvider(options.agent ?? "codex");
  const normalizedOptions: DeployOptions = { ...options, region, agent: agentProvider.id };

  const serviceDir = join(options.homeDir ?? homedir(), ".direxio", "nodes", serviceId);
  const context: ServiceContext = {
    serviceId,
    serviceDir,
    credentialsFile: join(serviceDir, "credentials.json")
  };
  const ts = options.now?.() ?? new Date().toISOString();
  const state = loadOrInitializeState(normalizedOptions, context, domain, ts);
  writeServiceState(context, state);

  await runAws(normalizedOptions, ["sts", "get-caller-identity"]);
  markPhaseDone(state, "S0_PREREQ_AWS", ts, "AWS caller identity verified");
  markPhaseDone(state, "S1_PREFLIGHT", ts, "deployment inputs validated");
  markPhaseDone(state, "S2_DOMAIN", ts, "production domain binding confirmed");
  writeServiceState(context, state);

  await provisionAwsResources(normalizedOptions, context, state, domain);
  markPhaseDone(state, "S3_PROVISION", ts, "AWS resources provisioned");
  writeServiceState(context, state);

  await waitForHealthz(normalizedOptions, domain);
  markPhaseDone(state, "S4_BOOTSTRAP_STACK", ts, `healthz 200 @ https://${domain}`);
  writeServiceState(context, state);

  const bootstrap = await bootstrapRemote(normalizedOptions, state, domain);
  Object.assign(state, {
    password: bootstrap.password,
    access_token: bootstrap.access_token,
    agent_token: bootstrap.agent_token,
    agent_room_id: bootstrap.agent_room_id,
    as_url: `https://${domain}`
  });
  markPhaseDone(state, "S5_INIT_TOKENS", ts, "bootstrap credentials collected");
  writeServiceState(context, state);
  writeCredentials(context, domain, bootstrap, state.agent_node_id);

  const matrixSession = await createMatrixSession(normalizedOptions, domain, bootstrap.agent_token, `direxio-connect-${serviceId}`);
  writeLocalWiring(normalizedOptions, context, state, domain, bootstrap, matrixSession, agentProvider);
  const serviceConfig = serviceConfigFromDeploy(context, domain, bootstrap, String(state.agent_node_id));
  const localWiringEvidence = await applyLocalInstallMode(normalizedOptions, context, state, serviceConfig);
  writeServiceState(context, state);
  markPhaseDone(state, "S6_WIRE_LOCAL", ts, localWiringEvidence);
  markPhaseDone(state, "S7_VERIFY_E2E", ts, "deployment automation completed");

  writeServiceState(context, state);
  const report = writeOperationReport(
    context,
    "new_deploy",
    "automated_gates_complete_user_confirmation_pending",
    state,
    ts
  );
  return {
    ok: true,
    service_id: serviceId,
    domain,
    state: join(serviceDir, "state.json"),
    report
  };
}

function initialState(options: DeployOptions, context: ServiceContext, domain: string, ts: string): ServiceState {
  const phaseState: Record<string, { status: string }> = {};
  for (const phase of phases) phaseState[phase] = { status: "pending" };
  const agent = options.agent ?? "codex";
  const domainMode = normalizeDomainMode(options.domainMode ?? "auto");
  const agentInstallMode = normalizeAgentInstallMode(options.agentInstallMode ?? "auto");
  return {
    run_id: `direxio-${Date.now()}`,
    region: options.region,
    domain_mode: domainMode,
    domain,
    domain_confirmed_irreversible: true,
    billing_warnings: [
      "EC2, EBS, public IPv4, Elastic IP, and Route53 hosted zones may keep billing until destroy completes.",
      "Elastic IP and public IPv4 charges may continue while allocated or attached.",
      "Route53 hosted zones are billable until deleted; user-owned parent zones and domain registrations are not destroyed by direxio."
    ],
    phase: "S0_PREREQ_AWS",
    created_at: ts,
    phases: phaseState,
    resources: {},
    agent_runtime: agent,
    agent_node_id: `${agent}-${domain.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
    agent_service_id: context.serviceId,
    agent_service_dir: context.serviceDir,
    agent_credentials_file: context.credentialsFile,
    agent_workspace: options.workspace ?? process.cwd(),
    connect_agent: agent,
    connect_binary: "direxio-connect",
    connect_npm_package: "direxio-connent@latest",
    connect_config: join(context.serviceDir, "direxio-connect", "config.toml"),
    connect_runtime_dir: join(context.serviceDir, "direxio-connect"),
    connect_install_policy: agentInstallMode,
    connect_install_mode: "direxio-connect",
    local_install_mode: agentInstallMode,
    local_install_commands: [],
    mcp_npm_package: "direxio-mcp@latest",
    mcp_command: "direxio-mcp",
    mcp_config_dir: join(context.serviceDir, "mcp"),
    mcp_credentials_file: context.credentialsFile
  };
}

function loadOrInitializeState(options: DeployOptions, context: ServiceContext, domain: string, ts: string): ServiceState {
  const base = initialState(options, context, domain, ts);
  if (!existsSync(serviceStateFile(context))) return base;
  const existing = readServiceState(context);
  const existingMode = normalizeDomainMode(existing.domain_mode || "auto");
  const requestedMode = normalizeDomainMode(options.domainMode ?? existingMode);
  const existingInstallMode = normalizeAgentInstallMode(existing.local_install_mode || existing.connect_install_policy || "auto");
  const requestedInstallMode = normalizeAgentInstallMode(options.agentInstallMode ?? existingInstallMode);
  if (options.domainMode && existingMode !== "auto" && requestedMode !== existingMode) {
    throw new Error(`state is bound to domain_mode=${existingMode}; refusing requested domain_mode=${requestedMode}`);
  }
  return {
    ...base,
    ...existing,
    region: options.region,
    domain,
    domain_mode: requestedMode,
    domain_confirmed_irreversible: true,
    phases: {
      ...base.phases,
      ...(existing.phases && typeof existing.phases === "object" ? existing.phases : {})
    },
    resources: existing.resources && typeof existing.resources === "object" ? existing.resources : {},
    agent_runtime: options.agent ?? existing.agent_runtime ?? base.agent_runtime,
    agent_service_id: context.serviceId,
    agent_service_dir: context.serviceDir,
    agent_credentials_file: context.credentialsFile,
    agent_workspace: options.workspace ?? existing.agent_workspace ?? base.agent_workspace,
    connect_agent: options.agent ?? existing.connect_agent ?? base.connect_agent,
    connect_config: join(context.serviceDir, "direxio-connect", "config.toml"),
    connect_runtime_dir: join(context.serviceDir, "direxio-connect"),
    connect_install_policy: requestedInstallMode,
    local_install_mode: requestedInstallMode,
    mcp_config_dir: join(context.serviceDir, "mcp"),
    mcp_credentials_file: context.credentialsFile,
    billing_warnings: Array.isArray(existing.billing_warnings) && existing.billing_warnings.length > 0
      ? existing.billing_warnings
      : base.billing_warnings
  };
}

async function provisionAwsResources(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string): Promise<void> {
  if (!state.resources || typeof state.resources !== "object") state.resources = {};
  const ami = stringValue(state.resources.ami_id) || await lookupUbuntuAmi(options);
  state.resources.ami_id = ami;
  writeServiceState(context, state);
  const sgId = stringValue(state.resources.sg_id) || await createSecurityGroup(options, domain);
  state.resources.sg_id = sgId;
  state.resources.sg_ingress_configured = true;
  writeServiceState(context, state);

  if (!stringValue(state.resources.key_name) || !stringValue(state.resources.key_file)) {
    const key = parseJsonObject((await runAws(options, ["ec2", "create-key-pair", "--key-name", `direxio-${domain}`])).stdout);
    state.resources.key_name = key.KeyName;
    state.resources.key_file = join(state.agent_service_dir, `${key.KeyName}.pem`);
    if (typeof key.KeyMaterial === "string") {
      writeFileSync(String(state.resources.key_file), key.KeyMaterial, { encoding: "utf8", mode: 0o600 });
      restrictPrivateFile(String(state.resources.key_file));
    }
    writeServiceState(context, state);
  }

  if (!stringValue(state.resources.user_data) || !stringValue(state.resources.instance_id)) {
    state.resources.user_data = renderUserData(state, domain);
    writeServiceState(context, state);
  }
  if (!stringValue(state.resources.instance_id)) {
    state.resources.root_volume_gb = DEFAULT_ROOT_VOLUME_GB;
    writeServiceState(context, state);
    const instance = parseJsonObject((await runAws(options, [
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      "t3.small",
      "--key-name",
      String(state.resources.key_name),
      "--security-group-ids",
      sgId,
      "--user-data",
      `file://${state.resources.user_data}`,
      "--block-device-mappings",
      rootBlockDeviceMappingsJson(),
      "--count",
      "1"
    ])).stdout);
    const createdInstance = instance.Instances?.[0] ?? {};
    state.resources.instance_id = createdInstance.InstanceId;
    state.resources.root_volume_id = createdInstance.BlockDeviceMappings?.[0]?.Ebs?.VolumeId ?? "";
    writeServiceState(context, state);
  }

  if (!stringValue(state.resources.eip_id) || !stringValue(state.resources.public_ip)) {
    const address = parseJsonObject((await runAws(options, ["ec2", "allocate-address", "--domain", "vpc"])).stdout);
    state.resources.eip_id = address.AllocationId;
    state.resources.public_ip = address.PublicIp;
    writeServiceState(context, state);
    await runAws(options, ["ec2", "associate-address", "--instance-id", String(state.resources.instance_id), "--allocation-id", String(address.AllocationId)]);
  }

  await configureDns(options, context, state, domain);
}

function rootBlockDeviceMappingsJson(): string {
  return JSON.stringify([
    {
      DeviceName: DEFAULT_ROOT_DEVICE_NAME,
      Ebs: {
        VolumeSize: DEFAULT_ROOT_VOLUME_GB,
        VolumeType: "gp3",
        DeleteOnTermination: true
      }
    }
  ]);
}

async function createSecurityGroup(options: DeployOptions, domain: string): Promise<string> {
  const sg = parseJsonObject((await runAws(options, [
    "ec2",
    "create-security-group",
    "--group-name",
    `direxio-${domain}`,
    "--description",
    `Direxio-${domain}`
  ])).stdout);
  const sgId = String(sg.GroupId);
  for (const rule of [
    { protocol: "tcp", port: "22" },
    { protocol: "tcp", port: "80" },
    { protocol: "tcp", port: "443" },
    { protocol: "tcp", port: "3478" },
    { protocol: "udp", port: "3478" },
    { protocol: "udp", port: "49160-49200" }
  ]) {
    await runAws(options, [
      "ec2",
      "authorize-security-group-ingress",
      "--group-id",
      sgId,
      "--protocol",
      rule.protocol,
      "--port",
      rule.port,
      "--cidr",
      "0.0.0.0/0"
    ]);
  }
  return sgId;
}

async function configureDns(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string): Promise<void> {
  const publicIp = String(state.resources.public_ip || "");
  const requestedMode = normalizeDomainMode(state.domain_mode || options.domainMode || "auto");
  let mode = requestedMode;

  if (mode === "auto") {
    const zone = stringValue(state.resources.route53_zone_id)
      ? {
          id: String(state.resources.route53_zone_id),
          name: String(state.resources.route53_zone_name || domain),
          created: String(state.resources.route53_zone_created_by_deployer) === "true"
        }
      : await findRoute53Zone(options, domain);
    if (zone) {
      mode = "route53";
      recordRoute53Zone(state, zone);
    } else {
      mode = "user";
    }
    state.domain_mode = mode;
    writeServiceState(context, state);
  }

  if (mode === "route53") {
    const zone = stringValue(state.resources.route53_zone_id)
      ? {
          id: String(state.resources.route53_zone_id),
          name: String(state.resources.route53_zone_name || domain),
          created: String(state.resources.route53_zone_created_by_deployer) === "true"
        }
      : await findOrCreateRoute53Zone(options, domain);
    recordRoute53Zone(state, zone);
    writeServiceState(context, state);
    await upsertRoute53ARecord(options, context, state, domain, publicIp);
  } else {
    state.domain_mode = "user";
    state.resources.user_dns_required = true;
    state.resources.user_dns_a_record = `${domain} A ${publicIp}`;
    writeServiceState(context, state);
  }

  await requireDnsReady(options, context, state, domain, publicIp);
}

async function upsertRoute53ARecord(
  options: DeployOptions,
  context: ServiceContext,
  state: ServiceState,
  domain: string,
  publicIp: string
): Promise<void> {
  const existing = await route53ExistingAValue(options, String(state.resources.route53_zone_id), domain);
  if (existing && existing !== publicIp) {
    state.resources.route53_existing_a_value = existing;
    state.resources.route53_pending_a_value = publicIp;
    if (!options.confirmDnsOverwrite) {
      const detail = "Route53 A record overwrite requires confirmation";
      markPhaseWaiting(state, "S3_PROVISION", new Date().toISOString(), detail);
      writeServiceState(context, state);
      throw new WaitingForUserAction(`${detail}: ${domain} ${existing} -> ${publicIp}; rerun with --confirm-dns-overwrite or DIREXIO_CONFIRM_DNS_OVERWRITE=1`);
    }
    state.resources.route53_overwrite_confirmed = "true";
  }

  const route53ChangeBatchFile = writeRoute53UpsertBatch(state, domain, publicIp);
  writeServiceState(context, state);
  const change = parseJsonObject((await runAws(options, [
    "route53",
    "change-resource-record-sets",
    "--hosted-zone-id",
    String(state.resources.route53_zone_id),
    "--change-batch",
    `file://${route53ChangeBatchFile}`
  ])).stdout);
  const changeId = stripChangeId(String(change.ChangeInfo?.Id || ""));
  if (changeId) {
    await runAws(options, ["route53", "wait", "resource-record-sets-changed", "--id", changeId]);
  }
}

async function route53ExistingAValue(options: DeployOptions, zoneId: string, domain: string): Promise<string> {
  if (!zoneId) return "";
  const records = parseJsonObject((await runAws(options, [
    "route53",
    "list-resource-record-sets",
    "--hosted-zone-id",
    zoneId
  ])).stdout);
  const wantedName = `${domain.replace(/\.+$/, "")}.`;
  for (const record of Array.isArray(records.ResourceRecordSets) ? records.ResourceRecordSets : []) {
    if (String(record.Name || "") === wantedName && String(record.Type || "") === "A") {
      const value = record.ResourceRecords?.[0]?.Value;
      return typeof value === "string" ? value : "";
    }
  }
  return "";
}

async function requireDnsReady(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string, publicIp: string): Promise<void> {
  if (await domainResolvesToIp(options.dnsResolver ?? defaultDnsResolver, domain, publicIp)) {
    state.dns_ready = true;
    writeServiceState(context, state);
    return;
  }
  state.dns_ready = false;
  const detail = `waiting for DNS A record ${domain} -> ${publicIp}`;
  markPhaseWaiting(state, "S3_PROVISION", new Date().toISOString(), detail);
  writeServiceState(context, state);
  throw new WaitingForUserAction(detail);
}

async function findOrCreateRoute53Zone(options: DeployOptions, domain: string): Promise<{ id: string; name: string; created: boolean; nameServers?: string }> {
  const existing = await findRoute53Zone(options, domain);
  if (existing) return existing;

  const created = parseJsonObject((await runAws(options, ["route53", "create-hosted-zone", "--name", domain, "--caller-reference", `${domain}-${Date.now()}`])).stdout);
  return {
    id: stripHostedZoneId(created.HostedZone?.Id ?? ""),
    name: domain,
    created: true,
    nameServers: Array.isArray(created.DelegationSet?.NameServers) ? created.DelegationSet.NameServers.join(",") : ""
  };
}

async function findRoute53Zone(options: DeployOptions, domain: string): Promise<{ id: string; name: string; created: boolean; nameServers?: string } | null> {
  const zones = parseJsonObject((await runAws(options, ["route53", "list-hosted-zones"])).stdout);
  let best: { id: string; name: string; length: number } | null = null;
  for (const zone of Array.isArray(zones.HostedZones) ? zones.HostedZones : []) {
    if (zone.Config?.PrivateZone === true) continue;
    const name = String(zone.Name ?? "").replace(/\.+$/, "").toLowerCase();
    if (!name) continue;
    if (domain === name || domain.endsWith(`.${name}`)) {
      if (!best || name.length > best.length) best = { id: stripHostedZoneId(String(zone.Id ?? "")), name, length: name.length };
    }
  }
  if (best?.id) return { id: best.id, name: best.name, created: false };
  return null;
}

function recordRoute53Zone(state: ServiceState, zone: { id: string; name: string; created: boolean; nameServers?: string }): void {
  state.resources.route53_zone_id = zone.id;
  state.resources.route53_zone_name = zone.name;
  if (!stringValue(state.resources.route53_zone_created_by_deployer) || zone.created) {
    state.resources.route53_zone_created_by_deployer = String(zone.created);
  }
  if (zone.nameServers) state.resources.route53_name_servers = zone.nameServers;
}

async function lookupUbuntuAmi(options: DeployOptions): Promise<string> {
  const result = parseJsonObject((await runAws(options, [
    "ssm",
    "get-parameters",
    "--names",
    "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id"
  ])).stdout);
  const ami = result.Parameters?.[0]?.Value;
  if (typeof ami !== "string" || !ami.startsWith("ami-")) {
    throw new Error("could not resolve Ubuntu 22.04 amd64 AMI from AWS SSM");
  }
  return ami;
}

function renderUserData(state: ServiceState, domain: string): string {
  const file = join(String(state.agent_service_dir), "user-data.yaml");
  const content = renderCloudInitUserData({ domain });
  writeFileSync(file, content, "utf8");
  return file;
}

async function waitForHealthz(options: DeployOptions, domain: string): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const attempts = envInteger("DIREXIO_HEALTH_POLL_MAX", 90);
  const intervalMs = envInteger("DIREXIO_HEALTH_POLL_INTERVAL_MS", 10_000);
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(`https://${domain}/healthz`, { method: "GET" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await delay(intervalMs);
    }
  }
  throw new Error(`healthz did not return 200 before timeout: https://${domain}/healthz${lastError ? ` (${lastError})` : ""}`);
}

async function bootstrapRemote(options: DeployOptions, state: ServiceState, domain: string): Promise<BootstrapCredentials> {
  const remoteBody = [
    "set -eu",
    "mkdir -p /var/direxio-message-server",
    "cd /var/direxio-message-server",
    `DOMAIN=${domain} bash /var/direxio-message-server/init-tokens.sh >/dev/null 2>&1 || true`,
    "cat /var/direxio-message-server/p2p/bootstrap.json"
  ].join("; ");
  const remoteScript = `sudo sh -lc ${shellQuote(remoteBody)}`;
  const result = await runCommand(options, "ssh", [
    "-i",
    String(state.resources.key_file),
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    `ubuntu@${state.resources.public_ip}`,
    remoteScript
  ]);
  const parsed = parseJsonObject(result.stdout);
  for (const key of ["password", "access_token", "agent_token", "agent_room_id"]) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      throw new Error(`remote bootstrap is missing ${key}`);
    }
  }
  return parsed as unknown as BootstrapCredentials;
}

async function createMatrixSession(
  options: DeployOptions,
  domain: string,
  agentToken: string,
  deviceId: string
): Promise<MatrixSession> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`https://${domain}/_p2p/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${agentToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action: "agent.matrix_session.create", params: { device_id: deviceId } })
  });
  const text = await response.text();
  const payload = parseJsonObject(text);
  if (!response.ok) {
    throw new Error(`agent.matrix_session.create failed with ${response.status}: ${text}`);
  }
  for (const key of ["access_token", "device_id", "user_id", "homeserver"]) {
    if (typeof payload[key] !== "string" || !payload[key]) {
      throw new Error(`agent.matrix_session.create response is missing ${key}`);
    }
  }
  return payload as unknown as MatrixSession;
}

function writeLocalWiring(
  options: DeployOptions,
  context: ServiceContext,
  state: ServiceState,
  domain: string,
  bootstrap: BootstrapCredentials,
  matrixSession: MatrixSession,
  provider: AgentProvider
): void {
  const connectDir = join(context.serviceDir, "direxio-connect");
  const agentCommand = provider.connect.commandEnv ? process.env[provider.connect.commandEnv] : undefined;
  mkdirSync(connectDir, { recursive: true });
  writeConnectConfig({
    configFile: join(connectDir, "config.toml"),
    dataDir: join(connectDir, "data"),
    project: String(state.agent_node_id),
    agent: provider.connect.agentType,
    workspace: options.workspace ?? process.cwd(),
    homeserver: matrixSession.homeserver || `https://${domain}`,
    matrixToken: matrixSession.access_token,
    matrixUser: matrixSession.user_id,
    roomId: bootstrap.agent_room_id,
    adminFrom: `@owner:${domain}`,
    agentCmd: agentCommand,
    agentOptionsToml: provider.connect.defaultOptionsToml
  });
  state.agent_runtime = provider.id;
  state.connect_agent = provider.connect.agentType;
  state.connect_provider = provider.id;
  state.connect_required_binaries = provider.connect.requiredBinaries;
  state.connect_matrix_user = matrixSession.user_id;
  state.connect_matrix_device = matrixSession.device_id;
  state.connect_matrix_homeserver = matrixSession.homeserver;
}

async function applyLocalInstallMode(
  options: DeployOptions,
  context: ServiceContext,
  state: ServiceState,
  serviceConfig: ServiceConfig
): Promise<string> {
  const mode = normalizeAgentInstallMode(state.local_install_mode || options.agentInstallMode || "auto");
  const target = options.mcpTarget ?? options.agent ?? "codex";
  state.local_install_mode = mode;
  state.connect_install_policy = mode;

  if (mode === "auto") {
    state.local_install_commands = [];
    await connectInstall(context, { runner: options.runner });
    state.connect_install_status = "installed";
    writeServiceState(context, state);
    const mcpInstall = await installMcpTarget(serviceConfig, target, { runner: options.runner });
    state.mcp_install_status = "installed";
    state.mcp_daemon_install_status = mcpInstall.daemon_install_mode === "detached_process" ? "detached_process" : "installed";
    state.mcp_target_artifacts = mcpInstall.artifacts;
    writeServiceState(context, state);
    const summary = await verifyRuntime(context, { runner: options.runner, fetch: options.fetch, now: options.now });
    Object.assign(state, readServiceState(context));
    if (summary.status !== "passed") {
      throw new Error(`runtime verification failed after local install: ${JSON.stringify(summary.checks)}`);
    }
    return "local credentials, connect, MCP wiring, and runtime verification completed";
  }

  if (mode === "recommend") {
    state.local_install_commands = localInstallCommands(context.serviceId, target);
    state.connect_install_status = "recommended";
    state.mcp_install_status = "recommended";
    state.mcp_daemon_install_status = "not_installed";
    state.mcp_target_artifacts = await writeMcpTargetArtifacts(serviceConfig, target);
    return "local credentials and config generated; install commands recommended";
  }

  state.local_install_commands = [];
  state.connect_install_status = "skipped";
  state.mcp_install_status = "skipped";
  state.mcp_daemon_install_status = "not_installed";
  state.mcp_target_artifacts = {};
  return "local credentials and connect config generated; local runtime install skipped";
}

function localInstallCommands(serviceId: string, target: string): string[] {
  return [
    `direxio connect install --service ${serviceId}`,
    `direxio mcp install --service ${serviceId} --target ${target}`,
    `direxio verify runtime --service ${serviceId}`
  ];
}

function writeCredentials(context: ServiceContext, domain: string, bootstrap: BootstrapCredentials, nodeId: unknown): void {
  mkdirSync(context.serviceDir, { recursive: true });
  writeFileSync(
    context.credentialsFile,
    `${JSON.stringify({
      profiles: {
        default: {
          domain,
          password: bootstrap.password,
          access_token: bootstrap.access_token,
          agent_room_id: bootstrap.agent_room_id,
          direxio_domain: `https://${domain}`,
          direxio_agent_token: bootstrap.agent_token,
          direxio_agent_room_id: bootstrap.agent_room_id,
          direxio_agent_node_id: String(nodeId)
        }
      }
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

function serviceConfigFromDeploy(
  context: ServiceContext,
  domain: string,
  bootstrap: BootstrapCredentials,
  agentNodeId: string
): ServiceConfig {
  return {
    ...context,
    domain: `https://${domain}`,
    agentToken: bootstrap.agent_token,
    agentRoomId: bootstrap.agent_room_id,
    agentNodeId
  };
}

async function runAws(options: DeployOptions, args: string[]): Promise<CommandResult> {
  return runCommand(options, "aws", ["--region", options.region.trim(), ...args]);
}

async function runCommand(options: DeployOptions, command: string, args: string[]): Promise<CommandResult> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.exitCode}`).trim());
  }
  return result;
}

function markPhaseDone(state: ServiceState, phase: string, ts: string, evidence: string): void {
  state.phase = phase;
  state.phases[phase] = { status: "done", ts, evidence };
}

function markPhaseWaiting(state: ServiceState, phase: string, ts: string, detail: string): void {
  state.phase = phase;
  state.phases[phase] = { status: "waiting_user", ts, detail };
}

function parseJsonObject(text: string): Record<string, any> {
  const parsed = text.trim() ? JSON.parse(text) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected object JSON");
  }
  return parsed as Record<string, any>;
}

function envInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDnsResolver: DnsResolver = {
  resolve4: (domain) => dnsPromises.resolve4(domain),
  resolveNs: (domain) => dnsPromises.resolveNs(domain),
  resolve4At: async (server, domain) => {
    const resolver = new dnsPromises.Resolver();
    resolver.setServers([server]);
    return await resolver.resolve4(domain);
  }
};

async function domainResolvesToIp(resolver: DnsResolver, domain: string, ip: string): Promise<boolean> {
  const authoritativeServers = await authoritativeNameServers(resolver, domain);
  if (authoritativeServers.length > 0 && resolver.resolve4At) {
    let authoritativeAnswered = false;
    for (const server of authoritativeServers) {
      try {
        const values = await resolver.resolve4At(server, domain);
        authoritativeAnswered = true;
        if (values.includes(ip)) return true;
      } catch {
        continue;
      }
    }
    if (authoritativeAnswered) return false;
  }

  try {
    return (await resolver.resolve4(domain)).includes(ip);
  } catch {
    return false;
  }
}

async function authoritativeNameServers(resolver: DnsResolver, domain: string): Promise<string[]> {
  if (!resolver.resolveNs) return [];
  const labels = domain.replace(/\.+$/, "").split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    try {
      const servers = await resolver.resolveNs(candidate);
      if (servers.length > 0) return servers;
    } catch {
      continue;
    }
  }
  return [];
}

function stringValue(value: unknown): string {
  if (value === null || typeof value === "undefined") return "";
  return String(value);
}

function restrictPrivateFile(file: string): void {
  chmodSync(file, 0o600);
  if (process.platform !== "win32") return;
  const account = process.env.USERDOMAIN && process.env.USERNAME
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME ?? "";
  if (!account) return;
  spawnSync("icacls", [file, "/inheritance:r"], { windowsHide: true });
  spawnSync("icacls", [file, "/grant:r", `${account}:R`], { windowsHide: true });
  spawnSync("icacls", [file, "/remove:g", "Users", "Authenticated Users", "Everyone"], { windowsHide: true });
}

function normalizeDomainName(value: string): string {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "").toLowerCase();
}

function normalizeDomainMode(value: unknown): DomainMode {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (normalized === "auto" || normalized === "user" || normalized === "route53") return normalized;
  throw new Error(`unknown domain_mode=${normalized}; expected auto, user, or route53`);
}

function normalizeAgentInstallMode(value: unknown): AgentInstallMode {
  const normalized = String(value || "auto").trim().toLowerCase();
  if (normalized === "auto" || normalized === "recommend" || normalized === "skip") return normalized;
  throw new Error(`unknown agent_install_mode=${normalized}; expected auto, recommend, or skip`);
}

function stripHostedZoneId(value: string): string {
  return value.replace(/^\/hostedzone\//, "");
}

function stripChangeId(value: string): string {
  return value.replace(/^\/change\//, "");
}

function route53UpsertARecordBatch(domain: string, ip: string): string {
  return JSON.stringify({
    Changes: [
      {
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: `${domain.replace(/\.+$/, "")}.`,
          Type: "A",
          TTL: 60,
          ResourceRecords: [{ Value: ip }]
        }
      }
    ]
  });
}

function writeRoute53UpsertBatch(state: ServiceState, domain: string, ip: string): string {
  const file = join(String(state.agent_service_dir), "route53-upsert-a.json");
  writeFileSync(file, `${route53UpsertARecordBatch(domain, ip)}\n`, "utf8");
  state.resources.route53_change_batch = file;
  return file;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
