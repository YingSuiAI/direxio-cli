import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentProviders } from "../src/agents/registry.js";
import { writeMcpTargetArtifacts } from "../src/mcp-config.js";
import type { ServiceConfig } from "../src/service-context.js";

function serviceConfig(home: string): ServiceConfig {
  const serviceDir = join(home, ".direxio", "nodes", "providers.example.test");
  return {
    serviceId: "providers.example.test",
    serviceDir,
    credentialsFile: join(serviceDir, "credentials.json"),
    domain: "https://providers.example.test",
    agentToken: "agent-token",
    agentRoomId: "!agents:providers.example.test",
    agentNodeId: "node-provider"
  };
}

describe("MCP target config artifacts", () => {
  it("writes provider-owned MCP artifacts for every agent provider", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-config-"));
    const config = serviceConfig(home);

    for (const provider of await listAgentProviders()) {
      const artifacts = await writeMcpTargetArtifacts(config, provider.id);
      const files = Object.values(artifacts).map((file) => basename(file)).sort();
      expect(files).toEqual([...provider.mcp.configFiles].sort());

      for (const file of Object.values(artifacts)) {
        expect(existsSync(file)).toBe(true);
        const text = readFileSync(file, "utf8");
        expect(text).toContain("direxio");
        expect(text).toContain("mcp");
        expect(text).toContain("proxy");
        expect(text).toContain("providers.example.test");
      }
    }
  });

  it("keeps compatibility targets for json, openclaw, and hermes", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-mcp-config-compat-"));
    const config = serviceConfig(home);

    await expect(writeMcpTargetArtifacts(config, "json")).resolves.toHaveProperty("json");
    await expect(writeMcpTargetArtifacts(config, "openclaw")).resolves.toHaveProperty("openclaw");
    await expect(writeMcpTargetArtifacts(config, "hermes")).resolves.toHaveProperty("hermes");
  });
});
