import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgentProvider } from "./agents/registry.js";
import type { AgentProvider } from "./agents/types.js";

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

export async function installSkill(input: SkillInstallInput): Promise<SkillInstallReport> {
  const provider = await resolveAgentProvider(input.agent);
  const base = input.homeDir ?? homedir();
  const target = join(base, ...provider.skill.pathSegments);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), skillMarkdown(provider), "utf8");
  return {
    ok: true,
    action: input.action,
    agent: provider.id,
    path: target
  };
}

function skillMarkdown(provider: AgentProvider): string {
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
direxio mcp install --service <service-id> --target ${provider.id}
direxio mcp proxy --service <service-id>
direxio update --service <service-id>
direxio reset-app-data --service <service-id> --confirm
direxio destroy --service <service-id>
\`\`\`

Default deploy behavior is \`--dns auto\` and \`--agent-install auto\`. Use \`--agent-install recommend\` to write files and commands without installing daemons, or \`--agent-install skip\` when the operator wants credentials/config only. Auto install must pass \`direxio verify runtime\` before the deployment is considered complete.

Never print Matrix access tokens, agent tokens, initialization codes, AWS secrets, private keys, or full credential files. Use \`direxio status --json\` for redacted machine-readable state.
`;
}
