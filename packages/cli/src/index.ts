#!/usr/bin/env node
import { spawn } from "node:child_process";
import { checkAgentProvider } from "./agents/check.js";
import { listAgentProviderSummaries } from "./agents/registry.js";
import { importAwsCsvCredentials, onboardAws, verifyAwsProfile } from "./aws-credentials.js";
import { connectInstall, connectLogs, connectRestart, connectStatus, type CommandRunner } from "./connect.js";
import {
  buildDeployConfirmationPlan,
  deployService,
  type AgentInstallMode,
  type CloudProvider,
  type DeployProgressEvent,
  type DnsResolver,
  type DomainMode
} from "./deploy.js";
import { destroyService } from "./destroy.js";
import { installMcpTarget } from "./mcp-config.js";
import {
  callMcpTool,
  createDoctorReport,
  installMcpDaemon,
  listMcpTools,
  mcpDaemonProxy,
  mcpDaemonStatus,
  mcpProxyCommand
} from "./mcp.js";
import { resetAppData, updateService } from "./ops.js";
import { loadServiceConfig, resolveServiceContext, writeActiveService } from "./service-context.js";
import { installSkill, type SkillAction } from "./skill.js";
import { buildStatusReport, confirmUserGate } from "./state.js";
import { verifyRuntime } from "./verify.js";

export interface CliRuntime {
  homeDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  fetch?: typeof fetch;
  dnsResolver?: DnsResolver;
  runner?: CommandRunner;
}

export async function runCli(argv: string[] = process.argv.slice(2), runtime: CliRuntime = {}): Promise<number> {
  const stdout = runtime.stdout ?? ((line: string) => console.log(line));
  const stderr = runtime.stderr ?? ((line: string) => console.error(line));
  try {
    const [command, ...rest] = argv;
    if (!command || command === "--help" || command === "-h" || command === "help") {
      stdout(usage());
      return 0;
    }
    const commandHelp = commandUsage(command, rest);
    if (commandHelp) {
      stdout(commandHelp);
      return 0;
    }
    if (command === "use") {
      const serviceId = rest[0]?.trim();
      if (!serviceId) throw new Error("use requires <service-id>");
      const file = writeActiveService(serviceId, runtime.homeDir);
      stdout(JSON.stringify({ ok: true, service_id: serviceId, active_service_file: file }, null, 2));
      return 0;
    }
    if (command === "onboard") {
      return runOnboard(rest, stdout);
    }
    if (command === "aws") {
      return await runAws(rest, runtime, stdout);
    }
    if (command === "mcp") {
      return await runMcp(rest, runtime, stdout);
    }
    if (command === "connect") {
      return await runConnect(rest, runtime, stdout);
    }
    if (command === "agents") {
      return await runAgents(rest, runtime, stdout);
    }
    if (command === "status") {
      const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
      printValue(buildStatusReport(context), rest.includes("--json"), stdout);
      return 0;
    }
    if (command === "confirm") {
      return runConfirm(rest, runtime, stdout);
    }
    if (command === "verify") {
      return await runVerify(rest, runtime, stdout);
    }
    if (command === "update") {
      const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
      printValue(
        await updateService(context, { runner: runtime.runner, messageServerImage: optionValue(rest, "--image") }),
        rest.includes("--json"),
        stdout
      );
      return 0;
    }
    if (command === "reset-app-data") {
      const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
      printValue(await resetAppData(context, { runner: runtime.runner, confirm: rest.includes("--confirm") }), rest.includes("--json"), stdout);
      return 0;
    }
    if (command === "destroy") {
      const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
      printValue(await destroyService(context, { runner: runtime.runner }), rest.includes("--json"), stdout);
      return 0;
    }
    if (command === "skill") {
      return await runSkill(rest, runtime, stdout);
    }
    if (command === "deploy") {
      const cloudSelection = cloudProviderSelection(rest);
      const deployConfirmed = rest.includes("--confirm-deploy") || rest.includes("--yes") || process.env.DIREXIO_CONFIRM_DEPLOY === "1";
      const domainConfirmed = rest.includes("--confirm-domain") || rest.includes("--yes") || process.env.CONFIRM_DOMAIN_BINDING === "1";
      const deployOptions = {
        homeDir: runtime.homeDir,
        serviceId: optionValue(rest, "--service") ?? optionValue(rest, "--domain") ?? process.env.DOMAIN ?? "",
        domain: optionValue(rest, "--domain") ?? process.env.DOMAIN ?? "",
        region: optionValue(rest, "--region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "",
        cloud: cloudSelection.value,
        domainMode: domainModeValue(rest),
        agent: optionValue(rest, "--agent") ?? process.env.DIREXIO_CONNECT_AGENT ?? "codex",
        agentInstallMode: agentInstallModeValue(rest),
        mcpTarget: optionValue(rest, "--mcp-target") ?? optionValue(rest, "--target"),
        workspace: optionValue(rest, "--workspace"),
        confirmDomainBinding: domainConfirmed,
        confirmDnsOverwrite: rest.includes("--confirm-dns-overwrite") || process.env.DIREXIO_CONFIRM_DNS_OVERWRITE === "1" || process.env.CONFIRM_DNS_OVERWRITE === "1",
        runner: runtime.runner,
        fetch: runtime.fetch,
        dnsResolver: runtime.dnsResolver,
        onProgress: (event: DeployProgressEvent) => stderr(formatDeployProgress(event))
      };
      if (!deployConfirmed) {
        const plan = await buildDeployConfirmationPlan({
          ...deployOptions,
          selectedCloudSource: cloudSelection.source
        });
        plan.confirm_command = deployConfirmCommand(rest, {
          ...deployOptions,
          cloud: plan.selected_cloud
        });
        printValue(
          plan,
          rest.includes("--json"),
          stdout
        );
        return 2;
      }
      if (cloudSelection.source === "default") {
        const plan = await buildDeployConfirmationPlan({
          ...deployOptions,
          selectedCloudSource: "default"
        });
        deployOptions.cloud = plan.selected_cloud;
      }
      printValue(
        await deployService(deployOptions),
        rest.includes("--json"),
        stdout
      );
      return 0;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    if (error && typeof error === "object" && "exitCode" in error && typeof (error as { exitCode?: unknown }).exitCode === "number") {
      return (error as { exitCode: number }).exitCode;
    }
    return 1;
  }
}

async function runSkill(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [action, ...rest] = argv;
  if (!action || action === "--help" || action === "-h" || action === "help" || rest.includes("--help") || rest.includes("-h")) {
    stdout(skillUsage());
    return 0;
  }
  if (!isSkillAction(action)) {
    throw new Error("skill requires install, update, or refresh");
  }
  const agent = optionValue(rest, "--agent");
  if (!agent) throw new Error("skill requires --agent <runtime>");
  printValue(await installSkill({ agent, homeDir: runtime.homeDir, action }), rest.includes("--json"), stdout);
  return 0;
}

function runOnboard(argv: string[], stdout: (line: string) => void): number {
  const [target, ...rest] = argv;
  if (target !== "aws") throw new Error("onboard requires aws");
  printValue(onboardAws(), rest.includes("--json"), stdout);
  return 0;
}

async function runAws(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "import-csv") {
    const csvFile = positionalValue(rest);
    if (!csvFile) throw new Error("aws import-csv requires <aws-access-key.csv>");
    printValue(await importAwsCsvCredentials({
      csvFile,
      profile: optionValue(rest, "--profile"),
      region: optionValue(rest, "--region"),
      homeDir: runtime.homeDir,
      runner: runtime.runner
    }), rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "verify") {
    printValue(await verifyAwsProfile({ profile: optionValue(rest, "--profile"), runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  throw new Error("aws requires import-csv or verify");
}

function isSkillAction(value: string | undefined): value is SkillAction {
  return value === "install" || value === "update" || value === "refresh";
}

function runConfirm(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): number {
  const [gate, ...rest] = argv;
  if (!gate) throw new Error("confirm requires <app-initialization|real-chat|agent-mcp-runtime>");
  const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
  const evidence = optionValue(rest, "--evidence") ?? process.env.DIREXIO_CONFIRM_EVIDENCE ?? "";
  const runtimeProbeConfirmed = rest.includes("--runtime-probe") || process.env.DIREXIO_CONFIRM_RUNTIME_PROBE === "1";
  printValue(confirmUserGate(context, gate, evidence, { runtimeProbeConfirmed }), rest.includes("--json"), stdout);
  return 0;
}

async function runVerify(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [target, ...rest] = argv;
  if (target !== "runtime") {
    throw new Error("verify requires runtime");
  }
  const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
  printValue(await verifyRuntime(context, { runner: runtime.runner, fetch: runtime.fetch }), rest.includes("--json"), stdout);
  return 0;
}

async function runConnect(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [action, ...rest] = argv;
  const context = resolveServiceContext({ homeDir: runtime.homeDir, service: optionValue(rest, "--service") });
  const serviceId = context.serviceId;
  if (action === "install") {
    printValue(await connectInstall(context, { runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "status") {
    printValue(await connectStatus(serviceId, { runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "logs") {
    const lines = Number(optionValue(rest, "-n") ?? optionValue(rest, "--lines") ?? "120");
    stdout(await connectLogs(serviceId, { runner: runtime.runner, lines }));
    return 0;
  }
  if (action === "restart") {
    printValue(await connectRestart(serviceId, { runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  throw new Error("connect requires install, status, logs, or restart");
}

async function runAgents(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [action, ...rest] = argv;
  if (action === "list") {
    printValue({ agents: await listAgentProviderSummaries() }, rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "check") {
    const agent = optionValue(rest, "--agent");
    if (!agent) throw new Error("agents check requires --agent <provider>");
    printValue(await checkAgentProvider(agent, { runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  throw new Error("agents requires list or check");
}

async function runMcp(argv: string[], runtime: CliRuntime, stdout: (line: string) => void): Promise<number> {
  const [action, ...rest] = argv;
  const service = optionValue(rest, "--service");
  if (action === "doctor") {
    const config = loadServiceConfig({ homeDir: runtime.homeDir, service });
    printValue(createDoctorReport(config), rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "tools") {
    printValue({ tools: listMcpTools() }, rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "status") {
    const serviceId = resolveServiceContext({ homeDir: runtime.homeDir, service }).serviceId;
    printValue(await mcpDaemonStatus(serviceId, { runner: runtime.runner }), rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "install") {
    const config = loadServiceConfig({ homeDir: runtime.homeDir, service });
    const target = optionValue(rest, "--target");
    const result = target
      ? await installMcpTarget(config, target, { runner: runtime.runner })
      : await installMcpDaemon(config, { runner: runtime.runner });
    printValue(result, rest.includes("--json"), stdout);
    return 0;
  }
  if (action === "proxy") {
    if (runtime.runner) {
      const result = await mcpDaemonProxy({ runner: runtime.runner });
      if (result.stdout) stdout(result.stdout);
      return 0;
    }
    const proxy = mcpProxyCommand();
    return runInheritedProcess(proxy.command, proxy.args);
  }
  if (action === "call") {
    const toolName = rest[0];
    if (!toolName) throw new Error("mcp call requires <tool-name>");
    const rawJson = optionValue(rest, "--json") ?? "{}";
    const input = JSON.parse(rawJson) as unknown;
    const config = loadServiceConfig({ homeDir: runtime.homeDir, service });
    const result = await callMcpTool(config, toolName, input, runtime.fetch ?? fetch);
    printValue(result, true, stdout);
    return 0;
  }
  throw new Error("mcp requires doctor, tools, call, install, status, or proxy");
}

function printValue(value: unknown, json: boolean, stdout: (line: string) => void): void {
  if (json) {
    stdout(JSON.stringify(value, null, 2));
  } else if (typeof value === "string") {
    stdout(value);
  } else {
    stdout(JSON.stringify(value, null, 2));
  }
}

function formatDeployProgress(event: DeployProgressEvent): string {
  const attempt = event.attempt && event.maxAttempts ? ` attempt=${event.attempt}/${event.maxAttempts}` : "";
  const next = event.nextDelayMs && event.nextDelayMs > 0 ? ` next=${Math.ceil(event.nextDelayMs / 1000)}s` : "";
  const elapsed = typeof event.elapsedMs === "number" && event.elapsedMs > 0 ? ` elapsed=${Math.ceil(event.elapsedMs / 1000)}s` : "";
  return `[deploy] ${event.phase} ${event.status}: ${event.message}${attempt}${elapsed}${next}`;
}

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function positionalValue(argv: string[]): string | undefined {
  const optionsWithValues = new Set(["--profile", "--region", "--service", "--domain", "--cloud", "--dns", "--domain-mode", "--agent", "--agent-install", "--local-install", "--mcp-target", "--target", "--workspace", "--evidence", "--image", "--lines", "-n"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value.startsWith("--") || value === "-n") {
      if (optionsWithValues.has(value) && argv[index + 1] && !argv[index + 1].startsWith("--")) index += 1;
      continue;
    }
    return value;
  }
  return undefined;
}

function domainModeValue(argv: string[]): DomainMode | undefined {
  const value = optionValue(argv, "--dns") ?? optionValue(argv, "--domain-mode") ?? process.env.DOMAIN_MODE;
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "user" || normalized === "route53") return normalized;
  throw new Error(`unknown domain mode: ${value}`);
}

function agentInstallModeValue(argv: string[]): AgentInstallMode | undefined {
  const value = optionValue(argv, "--agent-install") ?? optionValue(argv, "--local-install") ?? process.env.DIREXIO_AGENT_INSTALL;
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto" || normalized === "recommend" || normalized === "skip") return normalized;
  throw new Error(`unknown agent install mode: ${value}`);
}

function cloudProviderSelection(argv: string[]): { value: CloudProvider; source: "cli" | "env" | "default" } {
  const cliValue = optionValue(argv, "--cloud");
  if (cliValue) return { value: normalizeCloudProviderFlag(cliValue), source: "cli" };
  const envValue = process.env.DIREXIO_CLOUD_PROVIDER ?? process.env.DIREXIO_DEPLOY_PROVIDER;
  if (envValue) return { value: normalizeCloudProviderFlag(envValue), source: "env" };
  return { value: "lightsail", source: "default" };
}

function normalizeCloudProviderFlag(value: string): CloudProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "lightsail" || normalized === "ec2") return normalized;
  throw new Error(`unknown cloud provider: ${value}`);
}

function deployConfirmCommand(
  argv: string[],
  options: {
    serviceId: string;
    domain: string;
    region: string;
    cloud: CloudProvider;
    domainMode?: DomainMode;
    agent?: string;
    agentInstallMode?: AgentInstallMode;
    mcpTarget?: string;
    workspace?: string;
    confirmDnsOverwrite?: boolean;
  }
): string {
  const args = ["direxio", "deploy"];
  appendOption(args, "--service", options.serviceId);
  appendOption(args, "--domain", options.domain);
  appendOption(args, "--region", options.region);
  appendOption(args, "--cloud", options.cloud);
  appendOption(args, "--dns", options.domainMode);
  appendOption(args, "--agent", options.agent);
  appendOption(args, "--agent-install", options.agentInstallMode);
  appendOption(args, "--mcp-target", options.mcpTarget);
  appendOption(args, "--workspace", options.workspace);
  args.push("--confirm-domain");
  if (options.confirmDnsOverwrite && !argv.includes("--confirm-dns-overwrite")) args.push("--confirm-dns-overwrite");
  args.push("--confirm-deploy");
  return args.map(shellArg).join(" ");
}

function appendOption(args: string[], name: string, value: string | undefined): void {
  if (!value) return;
  args.push(name, value);
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function usage(): string {
  return `Usage:
  direxio --help
  direxio deploy --service <id> --domain <domain> --region <aws-region> [--cloud lightsail|ec2] [--dns auto|user|route53] [--agent-install auto|recommend|skip] [--confirm-deploy|--yes]
  direxio status --service <id>
  direxio update|reset-app-data|destroy --service <id>
  direxio onboard aws
  direxio aws import-csv <aws-access-key.csv> --profile <profile> --region <aws-region>
  direxio aws verify --profile <profile>
  direxio agents list [--json]
  direxio agents check --agent <provider> [--json]
  direxio connect install|status|logs|restart --service <id>
  direxio mcp tools [--json]
  direxio mcp doctor|install|status|proxy --service <id>
  direxio mcp call <tool-name> --service <id> --json '<input>'
  direxio skill install|update|refresh --agent <provider>
  direxio skill --help
  direxio use <service-id>

Deploy without --confirm-deploy prints the confirmation checklist first and exits with code 2. Run the returned confirm_command after the user confirms the checklist.
Run direxio <command> --help for command-specific operations and recovery guidance.`;
}

function commandUsage(command: string, argv: string[]): string | undefined {
  if (!wantsCommandHelp(argv)) return undefined;
  switch (command) {
    case "deploy":
      return deployUsage();
    case "status":
      return statusUsage();
    case "update":
      return updateUsage();
    case "reset-app-data":
      return resetAppDataUsage();
    case "destroy":
      return destroyUsage();
    case "connect":
      return connectUsage();
    case "mcp":
      return mcpUsage();
    case "agents":
      return agentsUsage();
    case "aws":
      return awsUsage();
    case "onboard":
      return onboardUsage();
    case "verify":
      return verifyUsage();
    case "confirm":
      return confirmUsage();
    case "use":
      return useUsage();
    case "skill":
      return skillUsage();
    default:
      return undefined;
  }
}

function wantsCommandHelp(argv: string[]): boolean {
  return argv[0] === "help" || argv.includes("--help") || argv.includes("-h");
}

function deployUsage(): string {
  return `Usage:
  direxio deploy --service <id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain [--json]
  direxio deploy --service <id> --domain <domain> --region <aws-region> --cloud <lightsail|ec2> --dns <auto|route53|user> --agent-install <auto|recommend|skip> --confirm-domain --confirm-deploy [--json]

Behavior:
  Without --confirm-deploy, deploy performs preflight discovery only, prints a confirmation checklist, and exits with code 2 before creating cloud resources.
  Review selected_cloud, Lightsail availability zone or EC2 fallback, DNS mode, agent install mode, estimated billing notes, and confirm_command with the user.
  Successful deploy output includes init_password, the one-time app initialization password. Deploy progress streams to stderr so JSON stdout remains parseable.
  Lightsail is the default. The checklist queries Free Tier usage, Lightsail bundles, and availability zones before selecting EC2 fallback.
  --dns auto uses Route53 when a matching public hosted zone exists; otherwise it waits for user-managed DNS.
  --agent-install auto installs and verifies direxio-connect and direxio-mcp before the deployment is considered ready.

After success:
  direxio status --service <id> --json
  direxio verify runtime --service <id> --json
  direxio mcp call search_rooms --service <id> --json '{"type":"all","limit":10}'`;
}

function statusUsage(): string {
  return `Usage:
  direxio status --service <id> [--json]
  direxio use <id>
  direxio status [--json]

Purpose:
  Read the redacted local service state, current deployment phase, resource ids, runtime evidence, and operation report path.
  Use this before update, reset, destroy, or recovery decisions. Status output must not expose Matrix tokens, AWS secrets, private keys, or initialization codes.`;
}

function updateUsage(): string {
  return `Usage:
  direxio update --service <id> [--image direxio/message-server:<tag>] [--json]

Purpose:
  Update the running backend image in place over SSH. This restarts Docker Compose on the recorded cloud instance without recreating Lightsail/EC2, DNS, fixed IP, or Docker volumes.

Recommended follow-up:
  direxio status --service <id> --json
  direxio verify runtime --service <id> --json
  direxio connect logs --service <id> --lines 120`;
}

function resetAppDataUsage(): string {
  return `Usage:
  direxio reset-app-data --service <id> --confirm [--json]

Purpose:
  Clear app data on the existing server while preserving the cloud instance, fixed IP, DNS, and Caddy TLS volumes.
  This invalidates old app users, rooms, messages, initialization code, access token, agent token, and local runtime evidence.

Recommended follow-up:
  direxio deploy --service <id> --domain <domain> --region <aws-region> --confirm-domain --confirm-deploy --json
  direxio verify runtime --service <id> --json`;
}

function destroyUsage(): string {
  return `Usage:
  direxio destroy --service <id> [--json]

Purpose:
  Stop the matching service-scoped local connect daemon, release recorded cloud resources, and remove local service files.
  Destroy uses recorded state. It does not remove purchased domains, user-owned hosted zones, or third-party DNS records.`;
}

function connectUsage(): string {
  return `Usage:
  direxio connect install --service <id> [--json]
  direxio connect status --service <id> [--json]
  direxio connect logs --service <id> [--lines 120]
  direxio connect restart --service <id> [--json]

Purpose:
  Manage the service-scoped direxio-connect Matrix bridge for the selected local agent runtime.
  Readiness requires status plus recent logs showing the bridge is running; do not treat process existence alone as success.`;
}

function mcpUsage(): string {
  return `Usage:
  direxio mcp install --service <id> --target <provider> [--json]
  direxio mcp status --service <id> [--json]
  direxio mcp doctor --service <id> [--json]
  direxio mcp tools [--json]
  direxio mcp call <tool-name> --service <id> --json '<input>'
  direxio mcp proxy --service <id>

Smoke test:
  direxio mcp call search_rooms --service <id> --json '{"type":"all","limit":10}'

Guidance:
  Use tools for discovery and one search_rooms call for read-only connectivity smoke. Do not test every MCP tool during deployment verification.
  For real business operations, call only the user-requested tool. Ask before write actions such as sending messages or comments.`;
}

function agentsUsage(): string {
  return `Usage:
  direxio agents list [--json]
  direxio agents check --agent <provider> [--json]

Purpose:
  List supported provider plugins and check the selected local agent executable before wiring connect or MCP.
  Supported providers include codex, cursor, gemini, claudecode, copilot, opencode, qoder, reasonix, tmux, and the rest shown by agents list.`;
}

function awsUsage(): string {
  return `Usage:
  direxio aws import-csv <aws-access-key.csv> --profile direxio-deployer --region <aws-region> [--json]
  direxio aws verify --profile direxio-deployer [--json]

Purpose:
  Import and verify deployment AWS credentials. Never print or commit AWS secrets. Prefer the dedicated DirexioDeployer IAM user path over root credentials when the user can complete the extra AWS console steps.`;
}

function onboardUsage(): string {
  return `Usage:
  direxio onboard aws [--json]

Purpose:
  Explain AWS account setup options, including root access key and dedicated IAM deployment user paths, before credentials are imported.`;
}

function verifyUsage(): string {
  return `Usage:
  direxio verify runtime --service <id> [--json]

Purpose:
  Verify local runtime readiness after deploy, connect install, MCP install, update, restart, or suspected local agent issues.
  The runtime check includes redacted credential inspection, connect daemon readiness, MCP doctor/tool discovery, and one read-only backend smoke.`;
}

function confirmUsage(): string {
  return `Usage:
  direxio confirm app-initialization --service <id> --evidence "<what the user completed>" [--json]
  direxio confirm real-chat --service <id> --evidence "<what the user observed>" [--json]
  direxio confirm agent-mcp-runtime --service <id> --runtime-probe --evidence "<what runtime probe proved>" [--json]

Purpose:
  Record user/runtime product gates with concrete evidence. Do not use generic evidence such as ok, yes, or done.`;
}

function useUsage(): string {
  return `Usage:
  direxio use <service-id>

Purpose:
  Store the active service id locally so later commands can omit --service. Use explicit --service when operating multiple nodes.`;
}

function skillUsage(): string {
  return `Usage:
  direxio skill install --agent <provider> [--json]
  direxio skill update --agent <provider> [--json]
  direxio skill refresh --agent <provider> [--json]

Purpose:
  Writes the final Direxio SKILL.md into the selected agent provider's skill directory.
  The generated skill explains deployment, deploy confirmation, local connect wiring,
  server operations, MCP smoke, runtime verification, and safety rules.
  Detailed operational help lives in direxio deploy --help, status --help,
  update --help, reset-app-data --help, destroy --help, connect --help, and mcp --help.

Find the provider:
  direxio agents list --json
  direxio agents check --agent <provider> --json

Common providers:
  codex, cursor, gemini, claudecode, copilot, opencode, qoder, reasonix, tmux

Examples:
  npx -y @direxio/cli@latest skill install --agent codex --json
  direxio skill update --agent cursor --json
  direxio mcp install --service <service-id> --target <provider> --json
  direxio --help`;
}

function runInheritedProcess(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
      stdio: "inherit",
      windowsHide: true
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
  });
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.endsWith("index.js") || entrypoint.endsWith("index.ts");
}

if (isDirectRun()) {
  const code = await runCli();
  process.exitCode = code;
}
