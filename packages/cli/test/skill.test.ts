import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installSkill } from "../src/skill.js";

describe("skill installation", () => {
  it("installs an agent-facing direxio skill for codex", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-skill-"));

    expect(installSkill({ agent: "codex", homeDir: home, action: "install" })).toEqual({
      ok: true,
      action: "install",
      agent: "codex",
      path: join(home, ".codex", "skills", "direxio")
    });

    const skillFile = join(home, ".codex", "skills", "direxio", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    expect(readFileSync(skillFile, "utf8")).toContain("direxio deploy");
    expect(readFileSync(skillFile, "utf8")).toContain("direxio verify runtime");
  });
});
