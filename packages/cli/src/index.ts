#!/usr/bin/env node
import { callMcpTool, createDoctorReport, listMcpTools } from "./mcp.js";
import { loadServiceConfig, writeActiveService } from "./service-context.js";

export interface CliRuntime {
  homeDir?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  fetch?: typeof fetch;
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
    if (command === "mcp") {
      return await runMcp(rest, runtime, stdout);
    }
    if (["deploy", "status", "destroy", "update", "reset-app-data", "verify", "confirm", "connect", "skill"].includes(command)) {
      stderr(`${command} migration is planned but not implemented in this slice`);
      return 2;
    }
    throw new Error(`unknown command: ${command}`);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
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
  if (["install", "status", "proxy"].includes(action ?? "")) {
    throw new Error(`mcp ${action} migration is planned but not implemented in this slice`);
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

function usage(): string {
  return `Usage:
  direxio deploy|status|destroy|update|reset-app-data
  direxio connect <install|status|logs|restart>
  direxio mcp <doctor|tools|call|install|status|proxy>
  direxio skill <install|update|refresh>
  direxio use <service-id>`;
}

function isDirectRun(): boolean {
  const entrypoint = process.argv[1] ?? "";
  return entrypoint.endsWith("index.js") || entrypoint.endsWith("index.ts");
}

if (isDirectRun()) {
  const code = await runCli();
  process.exitCode = code;
}
