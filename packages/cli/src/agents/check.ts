import { defaultRunner, type CommandRunner } from "../connect.js";
import { resolveAgentProvider } from "./registry.js";
import type { AgentProvider } from "./types.js";

export interface AgentBinaryCheck {
  binary: string;
  source: "default" | "env";
  env?: string;
  status: "passed" | "failed";
  evidence: string;
}

export interface AgentProviderCheckReport {
  status: "passed" | "failed";
  id: string;
  label: string;
  aliases: string[];
  connect_agent: string;
  command_env?: string;
  required_binaries: string[];
  checks: string[];
  binary_checks: AgentBinaryCheck[];
}

export interface AgentProviderCheckOptions {
  runner?: CommandRunner;
}

export async function checkAgentProvider(
  providerOrId: AgentProvider | string,
  options: AgentProviderCheckOptions = {}
): Promise<AgentProviderCheckReport> {
  const provider = typeof providerOrId === "string" ? await resolveAgentProvider(providerOrId) : providerOrId;
  const runner = options.runner ?? defaultRunner;
  const binaryChecks = await Promise.all(agentBinaryTargets(provider).map((target) => checkBinary(target, runner)));
  return {
    status: binaryChecks.every((check) => check.status === "passed") ? "passed" : "failed",
    id: provider.id,
    label: provider.label,
    aliases: provider.aliases,
    connect_agent: provider.connect.agentType,
    command_env: provider.connect.commandEnv,
    required_binaries: provider.verify.requiredBinaries,
    checks: provider.verify.checks,
    binary_checks: binaryChecks
  };
}

function agentBinaryTargets(provider: AgentProvider): Array<{ binary: string; source: "default" | "env"; env?: string }> {
  const commandOverride = commandFromEnv("DIREXIO_CONNECT_AGENT_CMD");
  if (commandOverride) {
    return [{ binary: commandOverride, source: "env", env: "DIREXIO_CONNECT_AGENT_CMD" }];
  }

  const providerOverride = provider.connect.commandEnv ? commandFromEnv(provider.connect.commandEnv) : "";
  if (providerOverride && provider.connect.commandEnv) {
    return [{ binary: providerOverride, source: "env", env: provider.connect.commandEnv }];
  }

  return provider.verify.requiredBinaries.map((binary) => ({ binary, source: "default" }));
}

async function checkBinary(
  target: { binary: string; source: "default" | "env"; env?: string },
  runner: CommandRunner
): Promise<AgentBinaryCheck> {
  const executable = commandExecutable(target.binary);
  const result = await runCommandExists(executable, runner);
  const evidence = result.exitCode === 0
    ? `${executable} is available`
    : `${executable} is not available in PATH`;
  return {
    ...target,
    binary: executable,
    status: result.exitCode === 0 ? "passed" : "failed",
    evidence
  };
}

async function runCommandExists(executable: string, runner: CommandRunner) {
  if (process.platform === "win32") {
    return await runner("where.exe", [executable]);
  }
  return await runner("sh", ["-lc", `command -v ${shellQuote(executable)}`]);
}

function commandFromEnv(name: string): string {
  return commandExecutable(process.env[name] ?? "");
}

function commandExecutable(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const quoted = /^(['"])(.*?)\1/.exec(trimmed);
  if (quoted?.[2]) return quoted[2];
  return trimmed.split(/\s+/)[0] ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
