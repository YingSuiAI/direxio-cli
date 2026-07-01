import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

function writeServiceCredentials(home: string, serviceId: string): void {
  const serviceDir = join(home, ".direxio", "nodes", serviceId);
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(
    join(serviceDir, "credentials.json"),
    JSON.stringify({
      profiles: {
        default: {
          direxio_domain: `https://${serviceId}`,
          direxio_agent_token: "agent-secret",
          direxio_agent_room_id: `!agents:${serviceId}`,
          direxio_agent_node_id: "codex-im"
        }
      }
    })
  );
}

describe("direxio CLI", () => {
  it("prints JSON mcp doctor reports", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "credentials.json"),
      JSON.stringify({
        profiles: {
          default: {
            direxio_domain: "https://im.example.com",
            direxio_agent_token: "agent-secret",
            direxio_agent_room_id: "!agents:im.example.com"
          }
        }
      })
    );
    const stdout: string[] = [];

    const code = await runCli(["mcp", "doctor", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      service_id: "im.example.com",
      domain: "https://im.example.com",
      token: "set:redacted"
    });
    expect(stdout.join("\n")).not.toContain("agent-secret");
  });

  it("routes connect status through the service-scoped daemon command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["connect", "status", "--service", "im", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: "Status: Running\nWorkDir: C:/Users/alice/.direxio/nodes/im/direxio-connect\n",
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      service_id: "im",
      status: "Running",
      work_dir: "C:/Users/alice/.direxio/nodes/im/direxio-connect",
      raw: "Status: Running\nWorkDir: C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });
  });

  it("routes connect install through npm, daemon install, and readiness checks", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im");
    const configFile = join(serviceDir, "direxio-connect", "config.toml");
    mkdirSync(join(serviceDir, "direxio-connect"), { recursive: true });
    writeFileSync(configFile, "config = true\n");
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["connect", "install", "--service", "im", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        if (command === "direxio-connect" && args[1] === "status") {
          return { stdout: "Status: Running\n", stderr: "", exitCode: 0 };
        }
        if (command === "direxio-connect" && args[1] === "logs") {
          return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "npm", args: ["install", "-g", "direxio-connent@latest"] },
      {
        command: "direxio-connect",
        args: ["daemon", "install", "--config", configFile, "--service-name", "im", "--force"]
      },
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] },
      { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im", "-n", "120"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      ok: true,
      service_id: "im",
      package: "direxio-connent@latest",
      config: configFile,
      readiness: "direxio-connect is running"
    });
  });

  it("routes mcp status through the service-scoped daemon command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "status", "--service", "im", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({ service_name: "direxio-mcp-im", status: "Stopped", url: "" }),
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-mcp", args: ["daemon", "status", "--service-name", "im", "--json"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      service_name: "direxio-mcp-im",
      status: "Stopped",
      url: ""
    });
  });

  it("routes mcp install through npm and daemon install", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    writeServiceCredentials(home, "im.example.com");
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "install", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "npm", args: ["install", "-g", "direxio-mcp@latest"] },
      {
        command: "direxio-mcp",
        args: [
          "daemon",
          "install",
          "--service-name",
          "im.example.com",
          "--credentials-file",
          join(home, ".direxio", "nodes", "im.example.com", "credentials.json"),
          "--node-id",
          "codex-im",
          "--host",
          "127.0.0.1",
          "--port",
          "19757"
        ]
      }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      ok: true,
      service_id: "im.example.com",
      package: "direxio-mcp@latest",
      daemon_url: "http://127.0.0.1:19757/mcp"
    });
  });

  it("routes mcp proxy through the stdio proxy command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "proxy"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "proxy exited\n", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-mcp", args: ["proxy", "--url", "http://127.0.0.1:19757/mcp"] }
    ]);
    expect(stdout.join("\n")).toBe("proxy exited\n");
  });

  it("does not treat mcp target snippet installation as migrated", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    writeServiceCredentials(home, "im.example.com");
    const stderr: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "install", "--service", "im.example.com", "--target", "codex"], {
      homeDir: home,
      stdout: () => {},
      stderr: (line) => stderr.push(line),
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(1);
    expect(commands).toEqual([]);
    expect(stderr.join("\n")).toContain("mcp install --target migration is planned");
  });

  it("prints redacted service status from state", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        domain: "im.example.com",
        password: "12345678",
        access_token: "ACCESS_SECRET",
        agent_token: "AGENT_SECRET",
        phases: { S7_VERIFY_E2E: { status: "done" } },
        runtime_checks: { summary: { status: "passed" } }
      }),
      "utf8"
    );
    const stdout: string[] = [];

    const code = await runCli(["status", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).not.toContain("12345678");
    expect(output).not.toContain("ACCESS_SECRET");
    expect(output).not.toContain("AGENT_SECRET");
    expect(JSON.parse(output)).toMatchObject({
      operation_type: "status",
      status: "status_report",
      domain: "im.example.com",
      security: { secrets_included: false }
    });
  });

  it("confirms user gates with explicit evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "state.json"), JSON.stringify({ domain: "im.example.com" }), "utf8");
    const stdout: string[] = [];

    const code = await runCli(
      [
        "confirm",
        "app-initialization",
        "--service",
        "im.example.com",
        "--evidence",
        "user finished app initialization with the current code",
        "--json"
      ],
      {
        homeDir: home,
        stdout: (line) => stdout.push(line),
        stderr: () => {}
      }
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      gate: "app_initialization",
      status: "confirmed"
    });
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      user_confirmations: {
        app_initialization: {
          status: "confirmed",
          evidence: "user finished app initialization with the current code"
        }
      }
    });
  });
});
