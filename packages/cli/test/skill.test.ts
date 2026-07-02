import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listAgentProviders } from "../src/agents/registry.js";
import { installSkill } from "../src/skill.js";

describe("skill installation", () => {
  it("installs an agent-facing direxio skill for codex", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-skill-"));

    await expect(installSkill({ agent: "codex", homeDir: home, action: "install" })).resolves.toEqual({
      ok: true,
      action: "install",
      agent: "codex",
      path: join(home, ".codex", "skills", "direxio")
    });

    const skillFile = join(home, ".codex", "skills", "direxio", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const skill = readFileSync(skillFile, "utf8");
    expect(skill).toContain("direxio --help");
    expect(skill).toContain("direxio skill --help");
    expect(skill).toContain("The first deploy prints a confirmation checklist");
    expect(skill).toContain("confirm_command");
    expect(skill).toContain("direxio verify runtime");
    expect(skill).toContain("direxio mcp tools");
    expect(skill).toContain("Do not test every MCP tool");
    expect(skill).toContain("direxio mcp call search_rooms");
    expect(skill).not.toContain("direxio mcp call send_message");
    expect(skill).toContain("direxio update --service <service-id> --image");
    expect(skill).toContain("restarts the backend image in place");
    expect(skill).toContain("Run command-specific help when unsure");
    expect(skill).toContain("Never print Matrix access tokens");
  });

  it("installs every provider skill at the provider-owned path", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-skill-all-"));

    for (const provider of await listAgentProviders()) {
      const result = await installSkill({ agent: provider.id, homeDir: home, action: "install" });
      expect(result).toMatchObject({
        ok: true,
        action: "install",
        agent: provider.id,
        path: join(home, ...provider.skill.pathSegments)
      });
      expect(readFileSync(join(result.path, "SKILL.md"), "utf8")).toContain(`--target ${provider.id}`);
    }
  });

  it("normalizes provider aliases before writing skills", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-skill-alias-"));

    await expect(installSkill({ agent: "claude", homeDir: home, action: "install" })).resolves.toMatchObject({
      agent: "claudecode",
      path: join(home, ".claude", "skills", "direxio")
    });
  });
});
