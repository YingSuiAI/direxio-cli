import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillAction = "install" | "update" | "refresh";

export interface SkillInstallInput {
  agent: string;
  homeDir?: string;
  action: SkillAction;
}

export interface SkillInstallReport {
  ok: true;
  action: SkillAction;
  agent: string;
  path: string;
}

const targetPaths: Record<string, string[]> = {
  acp: [".agents", "skills", "direxio"],
  antigravity: [".antigravity", "skills", "direxio"],
  claudecode: [".claude", "skills", "direxio"],
  codex: [".codex", "skills", "direxio"],
  copilot: [".github", "copilot", "skills", "direxio"],
  cursor: [".cursor", "skills", "direxio"],
  devin: [".devin", "skills", "direxio"],
  gemini: [".gemini", "skills", "direxio"],
  iflow: [".iflow", "skills", "direxio"],
  kimi: [".kimi", "skills", "direxio"],
  opencode: [".opencode", "skills", "direxio"],
  pi: [".pi", "agent", "skills", "direxio"],
  qoder: [".qoder", "skills", "direxio"],
  reasonix: [".reasonix", "skills", "direxio"],
  tmux: [".agent", "skills", "direxio"],
  generic: [".agent", "skills", "direxio"]
};

const aliases: Record<string, string> = {
  claude: "claudecode",
  "claude-code": "claudecode",
  openclaw: "acp",
  hermes: "acp",
  unknown: "generic"
};

export function installSkill(input: SkillInstallInput): SkillInstallReport {
  const agent = normalizeAgent(input.agent);
  const base = input.homeDir ?? homedir();
  const segments = targetPaths[agent];
  if (!segments) {
    throw new Error(`unsupported skill agent: ${input.agent}`);
  }
  const target = join(base, ...segments);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), skillMarkdown(agent), "utf8");
  return {
    ok: true,
    action: input.action,
    agent,
    path: target
  };
}

function normalizeAgent(agent: string): string {
  const normalized = agent.trim().toLowerCase();
  return aliases[normalized] ?? normalized;
}

function skillMarkdown(agent: string): string {
  return `---
name: direxio
description: Use the unified Direxio CLI to deploy, verify, destroy, wire connect, expose MCP, and refresh local agent runtime artifacts.
---

# Direxio

Use the \`direxio\` command for Direxio operations. Do not call legacy shell phase scripts directly.

Common commands:

\`\`\`bash
direxio onboard aws
direxio aws verify --profile direxio-deployer
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain
direxio status --service <service-id>
direxio verify runtime --service <service-id>
direxio connect install --service <service-id>
direxio mcp install --service <service-id> --target ${agent === "codex" ? "codex" : "<runtime>"}
direxio mcp proxy --service <service-id>
direxio update --service <service-id>
direxio reset-app-data --service <service-id> --confirm
direxio destroy --service <service-id>
\`\`\`

Default deploy behavior is \`--dns auto\` and \`--agent-install auto\`. Use \`--agent-install recommend\` to write files and commands without installing daemons, or \`--agent-install skip\` when the operator wants credentials/config only. Auto install must pass \`direxio verify runtime\` before the deployment is considered complete.

Never print Matrix access tokens, agent tokens, initialization codes, AWS secrets, private keys, or full credential files. Use \`direxio status --json\` for redacted machine-readable state.
`;
}
