#!/usr/bin/env node
import { spawn } from "node:child_process";
import { checkAgentProvider } from "./agents/check.js";
import { listAgentProviderSummaries } from "./agents/registry.js";
import { importAwsCsvCredentials, onboardAws, verifyAwsProfile } from "./aws-credentials.js";
import { connectInstall, connectLogs, connectRestart, connectStatus, type CommandRunner } from "./connect.js";
import { deployService, type AgentInstallMode, type DnsResolver, type DomainMode } from "./deploy.js";
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
    if (!command || command === "--help" || command === "-h") {
      stdout(usage());
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
      printValue(
        await deployService({
          homeDir: runtime.homeDir,
          serviceId: optionValue(rest, "--service") ?? optionValue(rest, "--domain") ?? process.env.DOMAIN ?? "",
          domain: optionValue(rest, "--domain") ?? process.env.DOMAIN ?? "",
          region: optionValue(rest, "--region") ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "",
          domainMode: domainModeValue(rest),
          agent: optionValue(rest, "--agent") ?? process.env.DIREXIO_CONNECT_AGENT ?? "codex",
          agentInstallMode: agentInstallModeValue(rest),
          mcpTarget: optionValue(rest, "--mcp-target") ?? optionValue(rest, "--target"),
          workspace: optionValue(rest, "--workspace"),
          confirmDomainBinding: rest.includes("--confirm-domain") || process.env.CONFIRM_DOMAIN_BINDING === "1",
          confirmDnsOverwrite: rest.includes("--confirm-dns-overwrite") || process.env.DIREXIO_CONFIRM_DNS_OVERWRITE === "1" || process.env.CONFIRM_DNS_OVERWRITE === "1",
          runner: runtime.runner,
          fetch: runtime.fetch,
          dnsResolver: runtime.dnsResolver
        }),
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
  const optionsWithValues = new Set(["--profile", "--region", "--service", "--domain", "--dns", "--domain-mode", "--agent", "--agent-install", "--local-install", "--mcp-target", "--target", "--workspace", "--evidence", "--image", "--lines", "-n"]);
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

function usage(): string {
  return `Usage:
  direxio deploy [--dns auto|user|route53] [--agent-install auto|recommend|skip]
  direxio status|destroy|update|reset-app-data
  direxio onboard aws
  direxio aws <import-csv|verify>
  direxio agents <list|check>
  direxio connect <install|status|logs|restart>
  direxio mcp <doctor|tools|call|install|status|proxy>
  direxio skill <install|update|refresh>
  direxio use <service-id>`;
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
