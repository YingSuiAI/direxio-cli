import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  connectInstall,
  connectLogs,
  connectRestart,
  connectStatus,
  writeConnectConfig,
  type CommandRunner
} from "../src/connect.js";

function fakeRunner(result: { stdout?: string; stderr?: string; exitCode?: number } = {}): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0
      };
    }
  };
}

describe("connect runtime", () => {
  it("reads daemon status for a service", async () => {
    const { runner, calls } = fakeRunner({
      stdout: "direxio-connect daemon status\n\n  Status:    Running\n  WorkDir:   C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });

    await expect(connectStatus("im", { runner })).resolves.toEqual({
      service_id: "im",
      status: "Running",
      work_dir: "C:/Users/alice/.direxio/nodes/im/direxio-connect",
      raw: "direxio-connect daemon status\n\n  Status:    Running\n  WorkDir:   C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] }
    ]);
  });

  it("tails daemon logs for a service", async () => {
    const { runner, calls } = fakeRunner({ stdout: "direxio-connect is running\n" });

    await expect(connectLogs("im", { runner, lines: 40 })).resolves.toBe("direxio-connect is running\n");
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im", "-n", "40"] }
    ]);
  });

  it("restarts the service-scoped daemon", async () => {
    const { runner, calls } = fakeRunner({ stdout: "restarted\n" });

    await expect(connectRestart("im", { runner })).resolves.toEqual({
      ok: true,
      service_id: "im",
      output: "restarted\n"
    });
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "restart", "--service-name", "im"] }
    ]);
  });

  it("installs the package and verifies daemon readiness", async () => {
    const serviceDir = mkdtempSync(join(tmpdir(), "direxio-cli-connect-"));
    const configFile = join(serviceDir, "direxio-connect", "config.toml");
    mkdirSync(join(serviceDir, "direxio-connect"), { recursive: true });
    writeFileSync(configFile, "config = true\n");
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      connectInstall(
        { serviceId: "im", serviceDir, credentialsFile: join(serviceDir, "credentials.json") },
        {
          runner: async (command, args) => {
            calls.push({ command, args });
            if (command === "direxio-connect" && args[1] === "status") {
              return { stdout: "Status: Running\nWorkDir: service-dir\n", stderr: "", exitCode: 0 };
            }
            if (command === "direxio-connect" && args[1] === "logs") {
              return { stdout: "config loaded\ninfo direxio-connect is running\n", stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
        }
      )
    ).resolves.toEqual({
      ok: true,
      service_id: "im",
      package: "direxio-connent@latest",
      config: configFile,
      readiness: "direxio-connect is running"
    });

    expect(calls).toEqual([
      { command: "npm", args: ["install", "-g", "direxio-connent@latest"] },
      {
        command: "direxio-connect",
        args: ["daemon", "install", "--config", configFile, "--service-name", "im", "--force"]
      },
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] },
      { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im", "-n", "120"] }
    ]);
  });

  it("fails install when daemon logs show local agent startup errors", async () => {
    const serviceDir = mkdtempSync(join(tmpdir(), "direxio-cli-connect-"));
    const configFile = join(serviceDir, "direxio-connect", "config.toml");
    mkdirSync(join(serviceDir, "direxio-connect"), { recursive: true });
    writeFileSync(configFile, "config = true\n");

    await expect(
      connectInstall(
        { serviceId: "im", serviceDir, credentialsFile: join(serviceDir, "credentials.json") },
        {
          startupTimeoutMs: 0,
          runner: async (command, args) => {
            if (command === "direxio-connect" && args[1] === "status") {
              return { stdout: "Status: Running\n", stderr: "", exitCode: 0 };
            }
            if (command === "direxio-connect" && args[1] === "logs") {
              return { stdout: "Authentication required. Please run agent login first.\n", stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          }
        }
      )
    ).rejects.toThrow("local agent backend failure: Authentication required");
  });

  it("writes a service-scoped direxio-connect Matrix config", () => {
    const serviceDir = mkdtempSync(join(tmpdir(), "direxio-cli-connect-"));
    const configFile = join(serviceDir, "direxio-connect", "config.toml");

    writeConnectConfig({
      configFile,
      dataDir: join(serviceDir, "direxio-connect", "data"),
      project: "codex-node",
      agent: "codex",
      workspace: join(serviceDir, "workspace"),
      homeserver: "https://service.example.test",
      matrixToken: "matrix-token",
      matrixUser: "@agent:service.example.test",
      roomId: "!agents-real:service.example.test",
      adminFrom: "@owner:service.example.test"
    });

    const config = readFileSync(configFile, "utf8");
    expect(config).toContain('language = "zh"');
    expect(config).toContain('type = "codex"');
    expect(config).toContain('admin_from = "@owner:service.example.test"');
    expect(config).toContain('backend = "app_server"');
    expect(config).toContain('app_server_url = "stdio"');
    expect(config).toContain('mode = "yolo"');
    expect(config).toContain('type = "matrix"');
    expect(config).toContain('homeserver = "https://service.example.test"');
    expect(config).toContain('access_token = "matrix-token"');
    expect(config).toContain('user_id = "@agent:service.example.test"');
    expect(config).toContain('room_id = "!agents-real:service.example.test"');
    expect(config).toContain("share_session_in_channel = true");
    expect(config).not.toContain("DIREXIO_CREDENTIALS_FILE");
  });

  it("lets explicit agent options override codex defaults", () => {
    const serviceDir = mkdtempSync(join(tmpdir(), "direxio-cli-connect-"));
    const configFile = join(serviceDir, "direxio-connect", "config.toml");

    writeConnectConfig({
      configFile,
      dataDir: join(serviceDir, "direxio-connect", "data"),
      project: "codex-node",
      agent: "codex",
      workspace: join(serviceDir, "workspace"),
      homeserver: "https://service.example.test",
      matrixToken: "matrix-token",
      matrixUser: "@agent:service.example.test",
      roomId: "!agents-real:service.example.test",
      adminFrom: "@owner:service.example.test",
      agentOptionsToml: 'mode = "full-auto"\nmodel = "gpt-5.5"'
    });

    const config = readFileSync(configFile, "utf8");
    expect(config).toContain('backend = "app_server"');
    expect(config).toContain('app_server_url = "stdio"');
    expect(config).toContain('mode = "full-auto"');
    expect(config).toContain('model = "gpt-5.5"');
    expect(config.match(/^\s*mode\s*=/gm)).toHaveLength(1);
  });
});
