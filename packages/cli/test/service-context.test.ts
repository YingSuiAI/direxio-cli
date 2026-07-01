import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadServiceConfig, resolveServiceContext } from "../src/service-context.js";

describe("service context", () => {
  it("resolves explicit service credentials under ~/.direxio/nodes", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-service-"));
    const context = resolveServiceContext({ homeDir: home, service: "im.example.com" });

    expect(context).toEqual({
      serviceId: "im.example.com",
      serviceDir: join(home, ".direxio", "nodes", "im.example.com"),
      credentialsFile: join(home, ".direxio", "nodes", "im.example.com", "credentials.json")
    });
  });

  it("loads deployer credentials without exposing token fields", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-service-"));
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

    const config = loadServiceConfig({ homeDir: home, service: "im.example.com" });

    expect(config).toEqual({
      serviceId: "im.example.com",
      serviceDir,
      credentialsFile: join(serviceDir, "credentials.json"),
      domain: "https://im.example.com",
      agentToken: "agent-secret",
      agentRoomId: "!agents:im.example.com",
      agentNodeId: "codex-im"
    });
  });
});
