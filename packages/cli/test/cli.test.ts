import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

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
});
