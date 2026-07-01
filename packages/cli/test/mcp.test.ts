import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDoctorReport, listMcpTools, callMcpTool } from "../src/mcp.js";
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
});
