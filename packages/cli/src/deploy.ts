import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { promises as dnsPromises } from "node:dns";
import { resolveAgentProvider } from "./agents/registry.js";
import type { AgentProvider } from "./agents/types.js";
import { renderCloudInitUserData, renderLightsailUserData } from "./cloud-init.js";
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
  cloud?: CloudProvider;
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
  onProgress?: (event: DeployProgressEvent) => void;
  now?: () => string;
}

export type DomainMode = "auto" | "user" | "route53";
export type AgentInstallMode = "auto" | "recommend" | "skip";
export type CloudProvider = "lightsail" | "ec2";

export interface DnsResolver {
  resolve4(domain: string): Promise<string[]>;
  resolveNs?: (domain: string) => Promise<string[]>;
  resolve4At?: (server: string, domain: string) => Promise<string[]>;
}

export interface DeployResult {
  ok: true;
  service_id: string;
  domain: string;
  init_password: string;
  state: string;
  report: string;
}

export interface DeployProgressEvent {
  phase: string;
  status: "running" | "waiting" | "done" | "failed";
  message: string;
  attempt?: number;
  maxAttempts?: number;
  elapsedMs?: number;
  nextDelayMs?: number;
}

export interface DeployConfirmationPlanOptions extends DeployOptions {
  selectedCloudSource?: "cli" | "env" | "default" | "availability";
  confirmCommand?: string;
}

export async function buildDeployConfirmationPlan(options: DeployConfirmationPlanOptions): Promise<Record<string, any>> {
  const serviceId = options.serviceId.trim();
  const domain = normalizeDomainName(options.domain);
  const region = options.region.trim();
  if (!serviceId) throw new Error("deploy requires serviceId");
  if (!domain) throw new Error("deploy requires domain");
  if (!region) throw new Error("deploy requires region");

  const ts = options.now?.() ?? new Date().toISOString();
  const selectedCloud = normalizeCloudProvider(options.cloud ?? "lightsail");
  const domainMode = normalizeDomainMode(options.domainMode ?? "auto");
  const agentInstallMode = normalizeAgentInstallMode(options.agentInstallMode ?? "auto");
  const agent = options.agent ?? "codex";
  const planOptions = { ...options, region, cloud: selectedCloud };
  const freeTier = await queryFreeTierUsage(planOptions, ts);
  const lightsail = await inspectLightsailAvailability(planOptions);
  const lightsailBundle = await inspectLightsailBundle(planOptions);
  const lightsailUsable = lightsail.status === "available" && lightsailBundle.status === "available";
  const lightsailAvailability = freeTierAvailability(freeTier, "lightsail");
  const ec2Availability = freeTierAvailability(freeTier, "ec2");
  const selectedCloudSource = options.selectedCloudSource ?? "default";
  const effectiveSelectedCloud = selectedCloud === "lightsail" && selectedCloudSource !== "cli" && !lightsailUsable ? "ec2" : selectedCloud;
  const effectiveSelectedCloudSource = effectiveSelectedCloud !== selectedCloud ? "availability" : selectedCloudSource;
  const recommendedCloud = !lightsailUsable
    ? "ec2"
    : lightsailAvailability === "exhausted" && ec2Availability === "remaining"
      ? "ec2"
      : "lightsail";

  return {
    ok: false,
    operation: "deploy",
    status: "confirmation_required",
    service_id: serviceId,
    domain,
    region,
    selected_cloud: effectiveSelectedCloud,
    selected_cloud_source: effectiveSelectedCloudSource,
    recommended_cloud: recommendedCloud,
    choices: {
      cloud: ["lightsail", "ec2"],
      dns: ["auto", "route53", "user"],
      agent_install: ["auto", "recommend", "skip"]
    },
    checklist: [
      {
        id: "cloud",
        label: "Cloud provider",
        selected: effectiveSelectedCloud,
        recommended: recommendedCloud,
        choices: ["lightsail", "ec2"]
      },
      {
        id: "lightsail_bundle",
        label: "Default Lightsail bundle",
        selected: "$12/month Linux/Unix bundle",
        details: {
          status: lightsailBundle.status,
          selected_bundle_id: lightsailBundle.bundle_id,
          monthly_usd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
          ram_gb: DEFAULT_LIGHTSAIL_RAM_GB,
          disk_gb: DEFAULT_LIGHTSAIL_DISK_GB,
          reason: lightsailBundle.reason,
          free_tier_note: LIGHTSAIL_FREE_TIER_NOTE
        }
      },
      {
        id: "lightsail_availability_zone",
        label: "Default Lightsail availability zone",
        selected: lightsail.selected_zone || defaultLightsailAvailabilityZone(region),
        details: {
          status: lightsail.status,
          default_zone: lightsail.default_zone,
          available_zones: lightsail.available_zones,
          unavailable_zones: lightsail.unavailable_zones,
          reason: lightsail.reason,
          validation: "deployment queries Lightsail regions; if the default zone is unavailable it selects another available Lightsail zone before recommending EC2"
        }
      },
      {
        id: "ec2_fallback",
        label: "Optional EC2 fallback",
        selected: DEFAULT_EC2_INSTANCE_TYPE,
        details: {
          root_volume_gb: DEFAULT_ROOT_VOLUME_GB
        }
      },
      {
        id: "dns",
        label: "DNS mode",
        selected: domainMode,
        choices: ["auto", "route53", "user"]
      },
      {
        id: "local_install",
        label: "Local agent install policy",
        selected: agentInstallMode,
        choices: ["auto", "recommend", "skip"]
      },
      {
        id: "agent",
        label: "Agent provider",
        selected: agent
      },
      {
        id: "mcp_target",
        label: "MCP target",
        selected: options.mcpTarget || agent
      },
      {
        id: "workspace",
        label: "Agent workspace",
        selected: options.workspace || process.cwd()
      }
    ],
    availability: {
      lightsail: {
        status: lightsailUsable ? "available" : "unavailable",
        bundle: lightsailBundle,
        availability_zone: lightsail
      },
      ec2: {
        status: "available_if_account_quota_allows",
        instance_type: DEFAULT_EC2_INSTANCE_TYPE,
        root_volume_gb: DEFAULT_ROOT_VOLUME_GB
      }
    },
    aws_free_tier: freeTier,
    confirmations: {
      domain_binding: options.confirmDomainBinding ? "confirmed" : "required",
      deploy_plan: "required"
    },
    confirm_command: options.confirmCommand || "",
    note: "Review the selected cloud, DNS, billing, and local install items before rerunning with --confirm-deploy."
  };
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
const DEFAULT_EC2_INSTANCE_TYPE = "t3.small";
const DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD = 12;
const DEFAULT_LIGHTSAIL_BLUEPRINT_ID = "ubuntu_22_04";
const DEFAULT_LIGHTSAIL_DISK_GB = 60;
const DEFAULT_LIGHTSAIL_RAM_GB = 2;

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
  const requestedCloud = options.cloud ?? process.env.DIREXIO_CLOUD_PROVIDER ?? process.env.DIREXIO_DEPLOY_PROVIDER ?? "lightsail";
  const normalizedOptions: DeployOptions = {
    ...options,
    region,
    cloud: normalizeCloudProvider(requestedCloud),
    agent: agentProvider.id
  };

  const serviceDir = join(options.homeDir ?? homedir(), ".direxio", "nodes", serviceId);
  const context: ServiceContext = {
    serviceId,
    serviceDir,
    credentialsFile: join(serviceDir, "credentials.json")
  };
  const ts = options.now?.() ?? new Date().toISOString();
  const state = loadOrInitializeState(normalizedOptions, context, domain, ts);
  writeServiceState(context, state);

  markPhaseRunning(state, "S0_PREREQ_AWS", ts, "verifying AWS caller identity");
  writeServiceState(context, state);
  emitProgress(normalizedOptions, "S0_PREREQ_AWS", "running", "verifying AWS caller identity");
  await runAws(normalizedOptions, ["sts", "get-caller-identity"]);
  markPhaseDone(state, "S0_PREREQ_AWS", ts, "AWS caller identity verified");
  emitProgress(normalizedOptions, "S0_PREREQ_AWS", "done", "AWS caller identity verified");
  markPhaseRunning(state, "S1_PREFLIGHT", ts, "checking cloud recommendation, Free Tier usage, Lightsail bundle, and availability zone");
  writeServiceState(context, state);
  emitProgress(normalizedOptions, "S1_PREFLIGHT", "running", "checking cloud recommendation, Free Tier usage, Lightsail bundle, and availability zone");
  await recordCloudRecommendation(normalizedOptions, context, state, ts);
  markPhaseDone(state, "S1_PREFLIGHT", ts, `deployment inputs validated; selected_cloud=${state.cloud_provider}`);
  emitProgress(normalizedOptions, "S1_PREFLIGHT", "done", `deployment inputs validated; selected_cloud=${state.cloud_provider}`);
  markPhaseDone(state, "S2_DOMAIN", ts, "production domain binding confirmed");
  emitProgress(normalizedOptions, "S2_DOMAIN", "done", "production domain binding confirmed");
  writeServiceState(context, state);

  markPhaseRunning(state, "S3_PROVISION", ts, "provisioning AWS resources and DNS");
  writeServiceState(context, state);
  emitProgress(normalizedOptions, "S3_PROVISION", "running", "provisioning AWS resources and DNS");
  try {
    await provisionAwsResources(normalizedOptions, context, state, domain);
  } catch (error) {
    if (error && typeof error === "object" && "exitCode" in error && (error as { exitCode?: unknown }).exitCode === 2) {
      const message = error instanceof Error ? error.message : String(error);
      emitProgress(normalizedOptions, "S3_PROVISION", "waiting", message);
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    markPhaseFailed(state, "S3_PROVISION", normalizedOptions.now?.() ?? new Date().toISOString(), message);
    state.deploy_error = message;
    writeServiceState(context, state);
    emitProgress(normalizedOptions, "S3_PROVISION", "failed", message);
    throw error;
  }
  markPhaseDone(state, "S3_PROVISION", ts, "AWS resources provisioned");
  emitProgress(normalizedOptions, "S3_PROVISION", "done", "AWS resources provisioned");
  writeServiceState(context, state);

  await waitForHealthz(normalizedOptions, context, state, domain);
  markPhaseDone(state, "S4_BOOTSTRAP_STACK", ts, `healthz 200 @ https://${domain}`);
  emitProgress(normalizedOptions, "S4_BOOTSTRAP_STACK", "done", `healthz 200 @ https://${domain}`);
  writeServiceState(context, state);

  markPhaseRunning(state, "S5_INIT_TOKENS", ts, "collecting bootstrap credentials over SSH");
  writeServiceState(context, state);
  emitProgress(normalizedOptions, "S5_INIT_TOKENS", "running", "collecting bootstrap credentials over SSH");
  const bootstrap = await bootstrapRemote(normalizedOptions, state, domain);
  Object.assign(state, {
    password: bootstrap.password,
    access_token: bootstrap.access_token,
    agent_token: bootstrap.agent_token,
    agent_room_id: bootstrap.agent_room_id,
    as_url: `https://${domain}`
  });
  markPhaseDone(state, "S5_INIT_TOKENS", ts, "bootstrap credentials collected");
  emitProgress(normalizedOptions, "S5_INIT_TOKENS", "done", "bootstrap credentials collected");
  writeServiceState(context, state);
  writeCredentials(context, domain, bootstrap, state.agent_node_id);

  markPhaseRunning(state, "S6_WIRE_LOCAL", ts, "wiring local credentials, connect, MCP, and runtime verification");
  writeServiceState(context, state);
  emitProgress(normalizedOptions, "S6_WIRE_LOCAL", "running", "wiring local credentials, connect, MCP, and runtime verification");
  const matrixSession = await createMatrixSession(normalizedOptions, domain, bootstrap.agent_token, `direxio-connect-${serviceId}`);
  writeLocalWiring(normalizedOptions, context, state, domain, bootstrap, matrixSession, agentProvider);
  const serviceConfig = serviceConfigFromDeploy(context, domain, bootstrap, String(state.agent_node_id));
  const localWiringEvidence = await applyLocalInstallMode(normalizedOptions, context, state, serviceConfig);
  writeServiceState(context, state);
  markPhaseDone(state, "S6_WIRE_LOCAL", ts, localWiringEvidence);
  emitProgress(normalizedOptions, "S6_WIRE_LOCAL", "done", localWiringEvidence);
  markPhaseDone(state, "S7_VERIFY_E2E", ts, "deployment automation completed");
  emitProgress(normalizedOptions, "S7_VERIFY_E2E", "done", "deployment automation completed");

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
    init_password: bootstrap.password,
    state: join(serviceDir, "state.json"),
    report
  };
}

function initialState(options: DeployOptions, context: ServiceContext, domain: string, ts: string): ServiceState {
  const phaseState: Record<string, { status: string }> = {};
  for (const phase of phases) phaseState[phase] = { status: "pending" };
  const agent = options.agent ?? "codex";
  const cloudProvider = normalizeCloudProvider(options.cloud ?? "lightsail");
  const domainMode = normalizeDomainMode(options.domainMode ?? "auto");
  const agentInstallMode = normalizeAgentInstallMode(options.agentInstallMode ?? "auto");
  return {
    run_id: `direxio-${Date.now()}`,
    region: options.region,
    cloud_provider: cloudProvider,
    instance_type: cloudProvider === "ec2" ? DEFAULT_EC2_INSTANCE_TYPE : "",
    domain_mode: domainMode,
    domain,
    domain_confirmed_irreversible: true,
    billing_warnings: [
      "Lightsail instances, static IPs, EC2, EBS, public IPv4, Elastic IP, and Route53 hosted zones may keep billing until destroy completes.",
      LIGHTSAIL_FREE_TIER_NOTE,
      "Lightsail static IP, Elastic IP, and public IPv4 charges may continue while allocated or attached.",
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
  const effectiveMode = requestedMode === "auto" && existingMode !== "auto" ? existingMode : requestedMode;
  const existingCloud = inferCloudProvider(existing);
  const requestedCloud = normalizeCloudProvider(options.cloud ?? "lightsail");
  const existingInstallMode = normalizeAgentInstallMode(existing.local_install_mode || existing.connect_install_policy || "auto");
  const requestedInstallMode = normalizeAgentInstallMode(options.agentInstallMode ?? existingInstallMode);
  if (options.domainMode && existingMode !== "auto" && effectiveMode !== existingMode) {
    throw new Error(`state is bound to domain_mode=${existingMode}; refusing requested domain_mode=${requestedMode}`);
  }
  if (options.cloud && existingCloud !== requestedCloud) {
    throw new Error(`state is bound to cloud_provider=${existingCloud}; refusing requested cloud_provider=${requestedCloud}`);
  }
  return {
    ...base,
    ...existing,
    region: options.region,
    cloud_provider: requestedCloud,
    instance_type: requestedCloud === "ec2" ? existing.instance_type || DEFAULT_EC2_INSTANCE_TYPE : existing.instance_type || "",
    domain,
    domain_mode: effectiveMode,
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
  const provider = normalizeCloudProvider(state.cloud_provider || options.cloud || "lightsail");
  state.cloud_provider = provider;
  if (provider === "lightsail") {
    await provisionLightsailResources(options, context, state, domain);
    return;
  }
  await provisionEc2Resources(options, context, state, domain);
}

async function provisionEc2Resources(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string): Promise<void> {
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
    state.instance_type = state.instance_type || DEFAULT_EC2_INSTANCE_TYPE;
    state.resources.root_volume_gb = DEFAULT_ROOT_VOLUME_GB;
    writeServiceState(context, state);
    const instance = parseJsonObject((await runAws(options, [
      "ec2",
      "run-instances",
      "--image-id",
      ami,
      "--instance-type",
      String(state.instance_type),
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

async function provisionLightsailResources(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string): Promise<void> {
  if (!state.resources || typeof state.resources !== "object") state.resources = {};
  const bundle = await resolveLightsailBundle(options, context, state);
  state.resources.lightsail_blueprint_id = stringValue(state.resources.lightsail_blueprint_id) || process.env.DIREXIO_LIGHTSAIL_BLUEPRINT_ID || DEFAULT_LIGHTSAIL_BLUEPRINT_ID;
  state.resources.lightsail_availability_zone = stringValue(state.resources.lightsail_availability_zone) || await resolveLightsailAvailabilityZone(options);
  state.resources.lightsail_instance_name = stringValue(state.resources.lightsail_instance_name) || awsResourceName("direxio", domain);
  state.resources.lightsail_static_ip_name = stringValue(state.resources.lightsail_static_ip_name) || awsResourceName("direxio-ip", domain);
  writeServiceState(context, state);

  if (!stringValue(state.resources.key_name) || !stringValue(state.resources.key_file)) {
    const keyName = awsResourceName("direxio-key", domain);
    const key = parseJsonObject((await runAws(options, ["lightsail", "create-key-pair", "--key-pair-name", keyName])).stdout);
    state.resources.key_name = stringValue(key.name) || keyName;
    state.resources.key_file = join(state.agent_service_dir, `${state.resources.key_name}.pem`);
    const keyMaterial = lightsailPrivateKeyMaterial(key);
    if (keyMaterial) {
      writeFileSync(String(state.resources.key_file), keyMaterial, { encoding: "utf8", mode: 0o600 });
      restrictPrivateFile(String(state.resources.key_file));
    }
    writeServiceState(context, state);
  }

  if (!stringValue(state.resources.user_data) || !stringValue(state.resources.instance_id)) {
    state.resources.user_data = renderUserData(state, domain);
    writeServiceState(context, state);
  }

  if (!stringValue(state.resources.instance_id)) {
    await runAws(options, [
      "lightsail",
      "create-instances",
      "--instance-names",
      String(state.resources.lightsail_instance_name),
      "--availability-zone",
      String(state.resources.lightsail_availability_zone),
      "--blueprint-id",
      String(state.resources.lightsail_blueprint_id),
      "--bundle-id",
      bundle.bundleId,
      "--key-pair-name",
      String(state.resources.key_name),
      "--user-data",
      `file://${state.resources.user_data}`
    ]);
    state.resources.instance_id = String(state.resources.lightsail_instance_name);
    state.resources.lightsail_instance_created = "true";
    writeServiceState(context, state);
  }
  if (String(state.resources.lightsail_ports_configured || "") !== "true") {
    await waitForLightsailInstanceRunning(options, context, state, String(state.resources.lightsail_instance_name));
    await openLightsailPorts(options, String(state.resources.lightsail_instance_name));
    state.resources.lightsail_ports_configured = "true";
    writeServiceState(context, state);
  }

  if (!stringValue(state.resources.public_ip)) {
    if (!await lightsailStaticIpExists(options, String(state.resources.lightsail_static_ip_name))) {
      await runAws(options, ["lightsail", "allocate-static-ip", "--static-ip-name", String(state.resources.lightsail_static_ip_name)]);
      writeServiceState(context, state);
    }
    await runAws(options, [
      "lightsail",
      "attach-static-ip",
      "--static-ip-name",
      String(state.resources.lightsail_static_ip_name),
      "--instance-name",
      String(state.resources.lightsail_instance_name)
    ]);
    const staticIp = parseJsonObject((await runAws(options, ["lightsail", "get-static-ip", "--static-ip-name", String(state.resources.lightsail_static_ip_name)])).stdout);
    state.resources.public_ip = stringValue(staticIp.staticIp?.ipAddress || staticIp.ipAddress);
    if (!state.resources.public_ip) {
      throw new Error(`Lightsail static IP ${state.resources.lightsail_static_ip_name} did not return an ipAddress`);
    }
    state.resources.static_ip_name = state.resources.lightsail_static_ip_name;
    writeServiceState(context, state);
  }

  await configureDns(options, context, state, domain);
}

interface LightsailBundleSelection {
  bundleId: string;
  monthlyPriceUsd: number;
  ramGb: number;
  diskGb: number;
  transferGb: number;
  cpuCount: number;
}

interface LightsailAvailabilityInspection {
  status: "available" | "unavailable" | "unknown";
  default_zone: string;
  selected_zone: string;
  available_zones: string[];
  unavailable_zones: string[];
  reason: string;
}

interface LightsailBundleInspection {
  status: "available" | "unavailable" | "unknown";
  bundle_id: string;
  monthly_usd: number;
  ram_gb: number;
  disk_gb: number;
  reason: string;
}

async function inspectLightsailAvailability(options: DeployOptions): Promise<LightsailAvailabilityInspection> {
  const defaultZone = defaultLightsailAvailabilityZone(options.region);
  const result = await tryAws(options, ["lightsail", "get-regions", "--include-availability-zones"]);
  if (result.exitCode !== 0) {
    return {
      status: "unknown",
      default_zone: defaultZone,
      selected_zone: "",
      available_zones: [],
      unavailable_zones: [],
      reason: firstLine(result.stderr || result.stdout || `aws exited with ${result.exitCode}`)
    };
  }
  try {
    const parsed = parseJsonObject(result.stdout);
    const inspection = inspectLightsailAvailabilityFromRegions(parsed, options.region);
    if (inspection.status === "available") return inspection;
    return {
      ...inspection,
      reason: inspection.reason || `no available Lightsail availability zone found for region ${options.region}`
    };
  } catch (error) {
    return {
      status: "unknown",
      default_zone: defaultZone,
      selected_zone: "",
      available_zones: [],
      unavailable_zones: [],
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function inspectLightsailBundle(options: DeployOptions): Promise<LightsailBundleInspection> {
  const override = process.env.DIREXIO_LIGHTSAIL_BUNDLE_ID;
  if (override) {
    return {
      status: "available",
      bundle_id: override,
      monthly_usd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
      ram_gb: DEFAULT_LIGHTSAIL_RAM_GB,
      disk_gb: DEFAULT_LIGHTSAIL_DISK_GB,
      reason: "using DIREXIO_LIGHTSAIL_BUNDLE_ID override"
    };
  }
  const result = await tryAws(options, ["lightsail", "get-bundles"]);
  if (result.exitCode !== 0) {
    return {
      status: "unknown",
      bundle_id: "",
      monthly_usd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
      ram_gb: DEFAULT_LIGHTSAIL_RAM_GB,
      disk_gb: DEFAULT_LIGHTSAIL_DISK_GB,
      reason: firstLine(result.stderr || result.stdout || `aws exited with ${result.exitCode}`)
    };
  }
  try {
    const parsed = parseJsonObject(result.stdout);
    const selected = selectLightsailBundle(Array.isArray(parsed.bundles) ? parsed.bundles : []);
    return {
      status: "available",
      bundle_id: selected.bundleId,
      monthly_usd: selected.monthlyPriceUsd,
      ram_gb: selected.ramGb,
      disk_gb: selected.diskGb,
      reason: ""
    };
  } catch (error) {
    return {
      status: "unavailable",
      bundle_id: "",
      monthly_usd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
      ram_gb: DEFAULT_LIGHTSAIL_RAM_GB,
      disk_gb: DEFAULT_LIGHTSAIL_DISK_GB,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

async function recordCloudRecommendation(options: DeployOptions, context: ServiceContext, state: ServiceState, ts: string): Promise<void> {
  const freeTier = await queryFreeTierUsage(options, ts);
  const lightsailAvailability = freeTierAvailability(freeTier, "lightsail");
  const ec2Availability = freeTierAvailability(freeTier, "ec2");
  const recommended = lightsailAvailability === "exhausted" && ec2Availability === "remaining" ? "ec2" : "lightsail";
  state.aws_free_tier = freeTier;
  state.cloud_recommendation = {
    checked_at: ts,
    default_provider: "lightsail",
    selected_provider: normalizeCloudProvider(state.cloud_provider || options.cloud || "lightsail"),
    recommended_provider: recommended,
    choices: ["lightsail", "ec2"],
    lightsail: {
      monthly_usd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
      ram_gb: DEFAULT_LIGHTSAIL_RAM_GB,
      disk_gb: DEFAULT_LIGHTSAIL_DISK_GB,
      note: `Default production bundle; select EC2 with --cloud ec2 or DIREXIO_CLOUD_PROVIDER=ec2. ${LIGHTSAIL_FREE_TIER_NOTE}`
    },
    ec2: {
      instance_type: DEFAULT_EC2_INSTANCE_TYPE,
      root_volume_gb: DEFAULT_ROOT_VOLUME_GB,
      note: "Retained for operators who need EC2-specific networking, quotas, or instance controls."
    },
    free_tier: {
      status: freeTier.status,
      lightsail: lightsailAvailability,
      ec2: ec2Availability
    }
  };
  writeServiceState(context, state);
}

async function queryFreeTierUsage(options: DeployOptions, ts: string): Promise<Record<string, any>> {
  const result = await tryAws(options, ["freetier", "get-free-tier-usage", "--output", "json"]);
  if (result.exitCode !== 0) {
    return {
      status: "unavailable",
      checked_at: ts,
      error: firstLine(result.stderr || result.stdout || `aws exited with ${result.exitCode}`)
    };
  }
  const parsed = parseJsonObject(result.stdout);
  const usages = Array.isArray(parsed.freeTierUsages)
    ? parsed.freeTierUsages
    : Array.isArray(parsed.FreeTierUsages)
      ? parsed.FreeTierUsages
      : [];
  return {
    status: "queried",
    checked_at: ts,
    usage_count: usages.length,
    usages: usages.map(redactFreeTierUsage)
  };
}

function redactFreeTierUsage(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const usage = value as Record<string, any>;
  return {
    service: stringValue(usage.service || usage.Service),
    operation: stringValue(usage.operation || usage.Operation),
    usage_type: stringValue(usage.usageType || usage.UsageType),
    region: stringValue(usage.region || usage.Region),
    actual_usage_amount: usage.actualUsageAmount ?? usage.ActualUsageAmount ?? null,
    forecasted_usage_amount: usage.forecastedUsageAmount ?? usage.ForecastedUsageAmount ?? null,
    limit: usage.limit ?? usage.Limit ?? null,
    unit: stringValue(usage.unit || usage.Unit),
    description: stringValue(usage.description || usage.Description)
  };
}

function freeTierAvailability(freeTier: Record<string, any>, provider: "lightsail" | "ec2"): "remaining" | "exhausted" | "unknown" {
  if (freeTier.status !== "queried" || !Array.isArray(freeTier.usages)) return "unknown";
  const matches = freeTier.usages.filter((usage: Record<string, any>) => {
    const text = [
      usage.service,
      usage.operation,
      usage.usage_type,
      usage.description
    ].map(stringValue).join(" ").toLowerCase();
    return provider === "lightsail" ? text.includes("lightsail") : text.includes("ec2") || text.includes("elastic compute");
  });
  if (matches.length === 0) return "unknown";
  return matches.some((usage: Record<string, any>) => usageRemaining(usage)) ? "remaining" : "exhausted";
}

function usageRemaining(usage: Record<string, any>): boolean {
  const limit = numberValue(usage.limit);
  const actual = numberValue(usage.actual_usage_amount);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(actual)) return false;
  return actual < limit;
}

async function resolveLightsailBundle(options: DeployOptions, context: ServiceContext, state: ServiceState): Promise<LightsailBundleSelection> {
  const recorded = stringValue(state.resources.lightsail_bundle_id);
  if (recorded) {
    return {
      bundleId: recorded,
      monthlyPriceUsd: numberValue(state.resources.lightsail_bundle_price_usd),
      ramGb: numberValue(state.resources.lightsail_bundle_ram_gb),
      diskGb: numberValue(state.resources.lightsail_bundle_disk_gb),
      transferGb: numberValue(state.resources.lightsail_bundle_transfer_gb),
      cpuCount: numberValue(state.resources.lightsail_bundle_cpu_count)
    };
  }

  const requestedBundle = process.env.DIREXIO_LIGHTSAIL_BUNDLE_ID;
  if (requestedBundle) {
    const selected = {
      bundleId: requestedBundle,
      monthlyPriceUsd: DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD,
      ramGb: DEFAULT_LIGHTSAIL_RAM_GB,
      diskGb: DEFAULT_LIGHTSAIL_DISK_GB,
      transferGb: 0,
      cpuCount: 0
    };
    recordLightsailBundle(state, selected);
    writeServiceState(context, state);
    return selected;
  }

  const bundles = parseJsonObject((await runAws(options, ["lightsail", "get-bundles"])).stdout);
  const selected = selectLightsailBundle(Array.isArray(bundles.bundles) ? bundles.bundles : []);
  recordLightsailBundle(state, selected);
  writeServiceState(context, state);
  return selected;
}

function selectLightsailBundle(rawBundles: any[]): LightsailBundleSelection {
  const candidates = rawBundles
    .filter((bundle) => {
      const platform = stringValue(bundle.supportedPlatforms || bundle.supportedPlatform || bundle.platform).toLowerCase();
      return !platform || platform.includes("linux") || platform.includes("unix");
    })
    .map((bundle) => ({
      bundleId: stringValue(bundle.bundleId),
      monthlyPriceUsd: numberValue(bundle.price),
      ramGb: numberValue(bundle.ramSizeInGb),
      diskGb: numberValue(bundle.diskSizeInGb),
      transferGb: numberValue(bundle.transferPerMonthInGb),
      cpuCount: numberValue(bundle.cpuCount)
    }))
    .filter((bundle) => bundle.bundleId.length > 0 && bundle.monthlyPriceUsd > 0);

  const exact = candidates
    .filter((bundle) =>
      approxEqual(bundle.monthlyPriceUsd, DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD)
      && bundle.ramGb >= DEFAULT_LIGHTSAIL_RAM_GB
      && bundle.diskGb >= DEFAULT_LIGHTSAIL_DISK_GB
    )
    .sort((a, b) => a.monthlyPriceUsd - b.monthlyPriceUsd || a.ramGb - b.ramGb || a.diskGb - b.diskGb)[0];
  if (exact) return exact;

  const fallback = candidates
    .filter((bundle) => bundle.monthlyPriceUsd >= DEFAULT_LIGHTSAIL_BUNDLE_MONTHLY_USD && bundle.ramGb >= DEFAULT_LIGHTSAIL_RAM_GB)
    .sort((a, b) => a.monthlyPriceUsd - b.monthlyPriceUsd || a.ramGb - b.ramGb || a.diskGb - b.diskGb)[0];
  if (fallback) return fallback;

  throw new Error("could not find a Lightsail Linux/Unix bundle near $12/month; set DIREXIO_LIGHTSAIL_BUNDLE_ID to override");
}

function recordLightsailBundle(state: ServiceState, bundle: LightsailBundleSelection): void {
  state.resources.lightsail_bundle_id = bundle.bundleId;
  state.resources.lightsail_bundle_price_usd = bundle.monthlyPriceUsd;
  state.resources.lightsail_bundle_ram_gb = bundle.ramGb;
  state.resources.lightsail_bundle_disk_gb = bundle.diskGb;
  state.resources.lightsail_bundle_transfer_gb = bundle.transferGb;
  state.resources.lightsail_bundle_cpu_count = bundle.cpuCount;
  state.cost_estimate = {
    provider: "lightsail",
    status: "bundle_price_recorded",
    total_monthly_usd: bundle.monthlyPriceUsd,
    components: {
      lightsail_bundle: {
        bundle_id: bundle.bundleId,
        monthly_usd: bundle.monthlyPriceUsd,
        ram_gb: bundle.ramGb,
        disk_gb: bundle.diskGb,
        transfer_gb: bundle.transferGb,
        cpu_count: bundle.cpuCount
      },
      route53_hosted_zone: {
        monthly_usd: state.domain_mode === "route53" ? 0.5 : 0,
        included: state.domain_mode === "route53"
      }
    }
  };
}

async function resolveLightsailAvailabilityZone(options: DeployOptions): Promise<string> {
  const override = process.env.DIREXIO_LIGHTSAIL_AVAILABILITY_ZONE;
  if (override) return override;
  const regions = await runAws(options, ["lightsail", "get-regions", "--include-availability-zones"]);
  const parsed = parseJsonObject(regions.stdout);
  const zone = selectLightsailAvailabilityZone(parsed, options.region);
  if (!zone) {
    throw new Error(`no available Lightsail availability zone found for region ${options.region}`);
  }
  return zone;
}

function selectLightsailAvailabilityZone(data: Record<string, any>, regionName: string): string {
  return inspectLightsailAvailabilityFromRegions(data, regionName).selected_zone;
}

function inspectLightsailAvailabilityFromRegions(data: Record<string, any>, regionName: string): LightsailAvailabilityInspection {
  const defaultZone = defaultLightsailAvailabilityZone(regionName);
  const region = (Array.isArray(data.regions) ? data.regions : []).find((item: any) => stringValue(item.name) === regionName);
  if (!region) {
    return {
      status: "unavailable",
      default_zone: defaultZone,
      selected_zone: "",
      available_zones: [],
      unavailable_zones: [],
      reason: `Lightsail region ${regionName} was not returned by get-regions`
    };
  }
  const allZones = Array.isArray(region.availabilityZones) ? region.availabilityZones : [];
  const availableZones = allZones
    .filter((item: any) => stringValue(item.zoneName) && stringValue(item.state).toLowerCase() !== "unavailable");
  const unavailableZones = allZones
    .filter((item: any) => stringValue(item.zoneName) && stringValue(item.state).toLowerCase() === "unavailable")
    .map((item: any) => stringValue(item.zoneName));
  const defaultAvailable = availableZones.find((item: any) => stringValue(item.zoneName) === defaultZone);
  const selectedZone = stringValue(defaultAvailable?.zoneName || availableZones[0]?.zoneName);
  return {
    status: selectedZone ? "available" : "unavailable",
    default_zone: defaultZone,
    selected_zone: selectedZone,
    available_zones: availableZones.map((item: any) => stringValue(item.zoneName)),
    unavailable_zones: unavailableZones,
    reason: selectedZone
      ? selectedZone === defaultZone
        ? ""
        : `default Lightsail zone ${defaultZone} is unavailable; selected ${selectedZone}`
      : `no available Lightsail availability zone found for region ${regionName}`
  };
}

function defaultLightsailAvailabilityZone(regionName: string): string {
  return `${regionName}${process.env.DIREXIO_LIGHTSAIL_DEFAULT_ZONE_SUFFIX || "a"}`;
}

async function openLightsailPorts(options: DeployOptions, instanceName: string): Promise<void> {
  for (const rule of [
    { protocol: "tcp", fromPort: "22", toPort: "22" },
    { protocol: "tcp", fromPort: "80", toPort: "80" },
    { protocol: "tcp", fromPort: "443", toPort: "443" },
    { protocol: "tcp", fromPort: "3478", toPort: "3478" },
    { protocol: "udp", fromPort: "3478", toPort: "3478" },
    { protocol: "udp", fromPort: "49160", toPort: "49200" }
  ]) {
    await runAws(options, [
      "lightsail",
      "open-instance-public-ports",
      "--instance-name",
      instanceName,
      "--port-info",
      `fromPort=${rule.fromPort},toPort=${rule.toPort},protocol=${rule.protocol}`
    ]);
  }
}

async function waitForLightsailInstanceRunning(
  options: DeployOptions,
  context: ServiceContext,
  state: ServiceState,
  instanceName: string
): Promise<void> {
  const attempts = envInteger("DIREXIO_LIGHTSAIL_INSTANCE_POLL_MAX", 60);
  const intervalMs = envInteger("DIREXIO_LIGHTSAIL_INSTANCE_POLL_INTERVAL_MS", 5_000);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = parseJsonObject((await runAws(options, ["lightsail", "get-instance", "--instance-name", instanceName])).stdout);
    const instanceState = stringValue(result.instance?.state?.name || result.instance?.state?.Name || result.state?.name || result.state?.Name);
    state.resources.lightsail_instance_state = instanceState;
    writeServiceState(context, state);
    emitProgress(options, "S3_PROVISION", "waiting", `waiting for Lightsail instance ${instanceName} to be running; current_state=${instanceState || "unknown"}`, {
      attempt,
      maxAttempts: attempts,
      nextDelayMs: attempt < attempts ? intervalMs : 0
    });
    if (instanceState.toLowerCase() === "running") return;
    if (attempt < attempts) await delay(intervalMs);
  }
  const message = `Lightsail instance ${instanceName} did not reach running before timeout; run direxio status --service ${state.agent_service_id || state.domain} --json, then retry deploy or destroy the partial service.`;
  markPhaseFailed(state, "S3_PROVISION", options.now?.() ?? new Date().toISOString(), message);
  state.deploy_error = message;
  writeServiceState(context, state);
  emitProgress(options, "S3_PROVISION", "failed", message);
  throw new Error(message);
}

async function lightsailStaticIpExists(options: DeployOptions, staticIpName: string): Promise<boolean> {
  const result = await tryAws(options, ["lightsail", "get-static-ip", "--static-ip-name", staticIpName]);
  return result.exitCode === 0;
}

function lightsailPrivateKeyMaterial(key: Record<string, any>): string {
  const raw = stringValue(key.privateKeyBase64 || key.PrivateKeyBase64);
  if (raw) return decodeLightsailPrivateKey(raw);
  return stringValue(key.privateKey || key.PrivateKey || key.KeyMaterial);
}

function decodeLightsailPrivateKey(raw: string): string {
  if (looksLikePem(raw)) return raw;
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return raw;
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  return decoded || raw;
}

function looksLikePem(value: string): boolean {
  return value.includes("-----BEGIN ") && value.includes(" PRIVATE KEY-----");
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
  const content = inferCloudProvider(state) === "lightsail"
    ? renderLightsailUserData({ domain })
    : renderCloudInitUserData({ domain });
  writeFileSync(file, content, "utf8");
  return file;
}

async function waitForHealthz(options: DeployOptions, context: ServiceContext, state: ServiceState, domain: string): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  const attempts = envInteger("DIREXIO_HEALTH_POLL_MAX", 90);
  const initialIntervalMs = envInteger("DIREXIO_HEALTH_POLL_INITIAL_INTERVAL_MS", 2_000);
  const intervalMs = envInteger("DIREXIO_HEALTH_POLL_INTERVAL_MS", 10_000);
  const fastAttempts = envInteger("DIREXIO_HEALTH_POLL_FAST_ATTEMPTS", 30);
  let lastError = "";
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const nextDelayMs = attempt < attempts ? healthPollDelayMs(attempt, { initialIntervalMs, intervalMs, fastAttempts }) : 0;
    const detail = `waiting for https://${domain}/healthz (${attempt}/${attempts})`;
    markPhaseRunning(state, "S4_BOOTSTRAP_STACK", options.now?.() ?? new Date().toISOString(), detail);
    writeServiceState(context, state);
    emitProgress(options, "S4_BOOTSTRAP_STACK", "waiting", detail, {
      attempt,
      maxAttempts: attempts,
      elapsedMs: Date.now() - startedAt,
      nextDelayMs
    });
    try {
      const response = await fetchImpl(`https://${domain}/healthz`, { method: "GET" });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      await delay(nextDelayMs);
    }
  }
  const message = `healthz did not return 200 before timeout: https://${domain}/healthz${lastError ? ` (${lastError})` : ""}. Run direxio status --service ${context.serviceId} --json, check ports 80/443, and inspect the cloud-init or Docker logs on the instance before retrying.`;
  markPhaseFailed(state, "S4_BOOTSTRAP_STACK", options.now?.() ?? new Date().toISOString(), message);
  state.deploy_error = message;
  writeServiceState(context, state);
  emitProgress(options, "S4_BOOTSTRAP_STACK", "failed", message, {
    elapsedMs: Date.now() - startedAt
  });
  throw new Error(message);
}

export function healthPollDelayMs(
  attempt: number,
  options: { initialIntervalMs?: number; intervalMs?: number; fastAttempts?: number } = {}
): number {
  const initialIntervalMs = options.initialIntervalMs ?? 2_000;
  const intervalMs = options.intervalMs ?? 10_000;
  const fastAttempts = options.fastAttempts ?? 30;
  return attempt <= fastAttempts ? initialIntervalMs : intervalMs;
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

async function tryAws(options: DeployOptions, args: string[]): Promise<CommandResult> {
  const runner = options.runner ?? defaultRunner;
  return runner("aws", ["--region", options.region.trim(), ...args]);
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

function markPhaseRunning(state: ServiceState, phase: string, ts: string, detail: string): void {
  state.phase = phase;
  state.phases[phase] = { status: "running", ts, detail };
}

function markPhaseFailed(state: ServiceState, phase: string, ts: string, detail: string): void {
  state.phase = phase;
  state.phases[phase] = { status: "failed", ts, detail };
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

const PUBLIC_RECURSIVE_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

const LIGHTSAIL_FREE_TIER_NOTE = "Amazon Lightsail currently offers three months free on select eligible bundles for each AWS account/user; verify Free Tier eligibility before relying on it because standard charges apply after the eligible allowance or when the account is not eligible.";

function emitProgress(
  options: DeployOptions,
  phase: string,
  status: DeployProgressEvent["status"],
  message: string,
  details: Omit<DeployProgressEvent, "phase" | "status" | "message"> = {}
): void {
  options.onProgress?.({ phase, status, message, ...details });
}

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
    if (resolver.resolve4At) {
      for (const server of PUBLIC_RECURSIVE_DNS_SERVERS) {
        try {
          if ((await resolver.resolve4At(server, domain)).includes(ip)) return true;
        } catch {
          continue;
        }
      }
    }
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

function numberValue(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function approxEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.01;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/)[0] ?? "";
}

function awsResourceName(prefix: string, value: string): string {
  const suffix = value
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${prefix}-${suffix}`.slice(0, 255);
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

function normalizeCloudProvider(value: unknown): CloudProvider {
  const normalized = String(value || "lightsail").trim().toLowerCase();
  if (normalized === "lightsail" || normalized === "ec2") return normalized;
  throw new Error(`unknown cloud_provider=${normalized}; expected lightsail or ec2`);
}

function inferCloudProvider(state: ServiceState): CloudProvider {
  const explicit = stringValue(state.cloud_provider || state.deploy_mode || state.cloud);
  if (explicit) return normalizeCloudProvider(explicit);
  const resources = state.resources && typeof state.resources === "object" ? state.resources : {};
  if (
    stringValue(resources.lightsail_instance_name)
    || stringValue(resources.lightsail_bundle_id)
    || stringValue(resources.lightsail_static_ip_name)
    || stringValue(resources.static_ip_name)
  ) {
    return "lightsail";
  }
  if (
    stringValue(resources.instance_id)
    || stringValue(resources.eip_id)
    || stringValue(resources.sg_id)
    || stringValue(resources.ami_id)
    || stringValue(resources.root_volume_id)
  ) {
    return "ec2";
  }
  return "lightsail";
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
