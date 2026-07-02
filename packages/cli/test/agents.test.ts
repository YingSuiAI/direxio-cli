import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkAgentProvider } from "../src/agents/check.js";
import { listAgentProviders, resolveAgentProvider } from "../src/agents/registry.js";

const providerIds = [
  "acp",
  "antigravity",
  "claudecode",
  "codex",
  "copilot",
  "cursor",
  "devin",
  "gemini",
  "iflow",
  "kimi",
  "opencode",
  "pi",
  "qoder",
  "reasonix",
  "tmux"
];

describe("agent providers", () => {
  it("lists every documented provider with complete compatibility metadata", async () => {
    const providers = await listAgentProviders();

    expect(providers.map((provider) => provider.id).sort()).toEqual([...providerIds].sort());
    for (const provider of providers) {
      expect(provider.label).not.toHaveLength(0);
      expect(provider.skill.pathSegments).not.toHaveLength(0);
      expect(provider.connect.agentType).not.toHaveLength(0);
      expect(provider.connect.requiredBinaries.length).toBeGreaterThan(0);
      expect(provider.mcp.configFiles.length).toBeGreaterThan(0);
      expect(provider.verify.checks).toEqual(expect.arrayContaining(["skill", "mcp", "connect"]));
    }
  });

  it("resolves provider ids and common aliases", async () => {
    await expect(resolveAgentProvider("cursor")).resolves.toMatchObject({ id: "cursor" });
    await expect(resolveAgentProvider("claude")).resolves.toMatchObject({ id: "claudecode" });
    await expect(resolveAgentProvider("claude-code")).resolves.toMatchObject({ id: "claudecode" });
    await expect(resolveAgentProvider("openclaw")).resolves.toMatchObject({ id: "acp" });
    await expect(resolveAgentProvider("hermes")).resolves.toMatchObject({ id: "acp" });
  });

  it("rejects unknown providers with the supported ids in the error", async () => {
    await expect(resolveAgentProvider("unknown-agent")).rejects.toThrow("unsupported agent provider: unknown-agent");
    await expect(resolveAgentProvider("unknown-agent")).rejects.toThrow("codex");
    await expect(resolveAgentProvider("unknown-agent")).rejects.toThrow("cursor");
    await expect(resolveAgentProvider("unknown-agent")).rejects.toThrow("gemini");
  });

  it("keeps the migration matrix synchronized with provider ids", () => {
    const matrix = readFileSync(join(process.cwd(), "..", "..", "docs", "agent-provider-migration.md"), "utf8");

    for (const id of providerIds) {
      expect(matrix).toContain(`| \`${id}\` |`);
    }
  });

  it("checks provider binaries through the selected platform probe", async () => {
    await withoutAgentCommandOverrides(async () => {
      const calls: Array<{ command: string; args: string[] }> = [];

      const report = await checkAgentProvider("cursor", {
        runner: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "cursor\n", stderr: "", exitCode: 0 };
        }
      });

      expect(calls).toEqual([providerProbeCall("cursor")]);
      expect(report).toMatchObject({
        status: "passed",
        id: "cursor",
        binary_checks: [{ binary: "cursor", status: "passed" }]
      });
    });
  });

  it("fails provider checks when required binaries are missing", async () => {
    await withoutAgentCommandOverrides(async () => {
      const report = await checkAgentProvider("cursor", {
        runner: async () => ({ stdout: "", stderr: "not found", exitCode: 1 })
      });

      expect(report).toMatchObject({
        status: "failed",
        id: "cursor",
        binary_checks: [{ binary: "cursor", status: "failed" }]
      });
    });
  });
});

function providerProbeCall(binary: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "where.exe", args: [binary] };
  }
  return { command: "sh", args: ["-lc", `command -v '${binary}'`] };
}

async function withoutAgentCommandOverrides(run: () => Promise<void>): Promise<void> {
  const previousGeneric = process.env.DIREXIO_CONNECT_AGENT_CMD;
  const previousCursor = process.env.DIREXIO_CURSOR_COMMAND;
  delete process.env.DIREXIO_CONNECT_AGENT_CMD;
  delete process.env.DIREXIO_CURSOR_COMMAND;
  try {
    await run();
  } finally {
    restoreEnv("DIREXIO_CONNECT_AGENT_CMD", previousGeneric);
    restoreEnv("DIREXIO_CURSOR_COMMAND", previousCursor);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
