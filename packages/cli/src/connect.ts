import { spawn } from "node:child_process";

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

export const defaultRunner: CommandRunner = (command, args) => {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: process.platform === "win32",
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

async function runConnect(options: ConnectRuntimeOptions, args: string[]): Promise<CommandResult> {
  const runner = options.runner ?? defaultRunner;
  const binary = options.binary ?? "direxio-connect";
  const result = await runner(binary, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `direxio-connect exited with ${result.exitCode}`).trim());
  }
  return result;
}

function parseField(text: string, field: string): string {
  const pattern = new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "im");
  return pattern.exec(text)?.[1]?.trim() ?? "";
}
