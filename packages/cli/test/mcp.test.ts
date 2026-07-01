import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDoctorReport,
  listMcpTools,
  callMcpTool,
  mcpDaemonStatus,
  installMcpDaemon,
  mcpDaemonProxy
} from "../src/mcp.js";
import { loadServiceConfig } from "../src/service-context.js";

function writeCredentials(home: string): void {
  const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(
    join(serviceDir, "credentials.json"),
    JSON.stringify({
      profiles: {
        default: {
          direxio_domain: "https://im.example.com",
          direxio_agent_token: "agent-secret",
          direxio_agent_room_id: "!agents:im.example.com",
          direxio_agent_node_id: "codex-im"
        }
      }
    })
  );
}

describe("mcp commands", () => {
  it("builds a redacted doctor report from service credentials", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-"));
    writeCredentials(home);
    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });

    expect(createDoctorReport(config)).toEqual({
      ok: true,
      service_id: "im.example.com",
      domain: "https://im.example.com",
      agent_room_id: "!agents:im.example.com",
      agent_node_id: "codex-im",
      token: "set:redacted",
      transport: "direxio-cli"
    });
  });

  it("lists migrated MCP tools", () => {
    expect(listMcpTools()).toEqual([
      "list_contacts",
      "search_rooms",
      "send_message",
      "list_messages",
      "list_room_members",
      "list_channel_posts",
      "list_post_comments",
      "comment_channel_post"
    ]);
  });

  it("calls query tools with default agent room id", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-"));
    writeCredentials(home);
    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });
    const calls: Array<{ url: string; body: unknown; authorization: string | null }> = [];

    const result = await callMcpTool(config, "list_messages", {}, async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body))
      });
      return new Response(JSON.stringify({ messages: [] }), { status: 200 });
    });

    expect(result).toEqual({ messages: [] });
    expect(calls).toEqual([
      {
        url: "https://im.example.com/_p2p/query",
        authorization: "Bearer agent-secret",
        body: {
          action: "mcp.messages.list",
          params: {
            room_id: "!agents:im.example.com"
          }
        }
      }
    ]);
  });

  it("rejects owner send_message calls to the agent room", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-"));
    writeCredentials(home);
    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });

    await expect(
      callMcpTool(config, "send_message", { room_id: "!agents:im.example.com", msg: "hello" }, fetch)
    ).rejects.toThrow("send_message cannot target the service agent room");
  });

  it("reads service-scoped mcp daemon status", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      mcpDaemonStatus("im", {
        runner: async (command, args) => {
          calls.push({ command, args });
          return {
            stdout: JSON.stringify({
              service_name: "direxio-mcp-im",
              status: "Running",
              url: "http://127.0.0.1:19757/mcp"
            }),
            stderr: "",
            exitCode: 0
          };
        }
      })
    ).resolves.toEqual({
      service_name: "direxio-mcp-im",
      status: "Running",
      url: "http://127.0.0.1:19757/mcp"
    });
    expect(calls).toEqual([
      { command: "direxio-mcp", args: ["daemon", "status", "--service-name", "im", "--json"] }
    ]);
  });

  it("installs the mcp package and service-scoped daemon", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-"));
    writeCredentials(home);
    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      installMcpDaemon(config, {
        runner: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).resolves.toEqual({
      ok: true,
      service_id: "im.example.com",
      package: "direxio-mcp@latest",
      daemon_url: "http://127.0.0.1:19757/mcp"
    });

    expect(calls).toEqual([
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
  });

  it("falls back to a detached daemon run when Windows task registration is denied", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-"));
    writeCredentials(home);
    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });
    const calls: Array<{ command: string; args: string[] }> = [];
    const detached: Array<{ command: string; args: string[] }> = [];

    await expect(
      installMcpDaemon(config, {
        runner: async (command, args) => {
          calls.push({ command, args });
          if (command === "direxio-mcp" && args[1] === "install") {
            return { stdout: "", stderr: "schtasks install failed: ERROR: Access is denied.", exitCode: 1 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        startDetached: (command, args) => {
          detached.push({ command, args });
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      service_id: "im.example.com",
      daemon_url: "http://127.0.0.1:19757/mcp",
      daemon_install_mode: "detached_process"
    });

    expect(detached).toEqual([
      {
        command: "direxio-mcp",
        args: ["daemon", "run", "--service-name", "im.example.com"]
      }
    ]);
    expect(calls).toContainEqual({
      command: "direxio-mcp",
      args: [
        "daemon",
        "write-metadata",
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
    });
  });

  it("runs the stdio proxy against the local mcp daemon URL", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      mcpDaemonProxy({
        runner: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "proxy exited\n", stderr: "", exitCode: 0 };
        }
      })
    ).resolves.toEqual({ stdout: "proxy exited\n", stderr: "", exitCode: 0 });

    expect(calls).toEqual([
      { command: "direxio-mcp", args: ["proxy", "--url", "http://127.0.0.1:19757/mcp"] }
    ]);
  });
});
