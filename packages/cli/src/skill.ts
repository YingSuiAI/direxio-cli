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
description: Use when deploying, verifying, operating, or destroying a Direxio service, wiring direxio-connect or MCP for a local agent runtime, or using Direxio MCP tools to read and send messages.
---

# Direxio

Direxio is operated through the \`direxio\` CLI. Do not call legacy shell phase scripts directly. If \`direxio\` is not on PATH, run the same command through \`npx -y @direxio/cli@latest <command>\`.

## Start Here

\`\`\`bash
direxio --help
direxio skill --help
direxio agents list --json
direxio agents check --agent ${provider.id} --json
direxio skill update --agent ${provider.id} --json
\`\`\`

Use only the current provider unless the user asks to prepare another runtime. This installed skill targets \`${provider.id}\`; MCP client snippets for this runtime are installed after a service exists with \`direxio mcp install --service <service-id> --target ${provider.id}\`.

## Deploy A Service

\`\`\`bash
direxio onboard aws
direxio aws import-csv <aws-access-key.csv> --profile direxio-deployer --region <aws-region>
direxio aws verify --profile direxio-deployer
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain --json
\`\`\`

The first deploy prints a confirmation checklist and exits with code \`2\`; that is expected. Review the checklist with the user before cloud resources are created. Then run the returned \`confirm_command\`, or run the equivalent command with the confirmed cloud choice:

\`\`\`bash
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --cloud <lightsail|ec2> --dns auto --agent-install auto --confirm-domain --confirm-deploy --json
direxio status --service <service-id> --json
direxio verify runtime --service <service-id> --json
\`\`\`

Default deploy choices are \`--cloud lightsail\`, \`--dns auto\`, and \`--agent-install auto\`. The checklist queries AWS Free Tier, Lightsail bundles, and Lightsail availability zones before the user confirms. Use EC2 only when the checklist selects it, the user selects it, or Lightsail is unavailable. \`--dns auto\` uses a matching Route53 public hosted zone when present; otherwise it waits for user-managed DNS. \`--agent-install auto\` installs connect/MCP and must pass runtime verification before deployment is complete.

## Local Runtime

\`\`\`bash
direxio connect install --service <service-id> --json
direxio connect status --service <service-id> --json
direxio connect logs --service <service-id> --lines 120
direxio connect restart --service <service-id> --json
direxio mcp install --service <service-id> --target ${provider.id} --json
direxio mcp status --service <service-id> --json
direxio mcp doctor --service <service-id> --json
direxio mcp tools --json
direxio mcp proxy --service <service-id>
\`\`\`

Use \`direxio verify runtime --service <service-id> --json\` after install, update, restart, or any suspected local agent problem. Do not report the runtime as ready from process existence alone; readiness requires the CLI checks to pass.

## MCP Smoke

Use one read-only room query to prove MCP can reach the backend. Do not test every MCP tool during deployment verification.

\`\`\`bash
direxio mcp tools --json
direxio mcp call search_rooms --service <service-id> --json '{"type":"all","limit":10}'
\`\`\`

If the smoke query returns without auth, HTTP, or schema errors, MCP connectivity is good enough. For real business actions, first inspect \`direxio mcp tools --json\`, then call only the tool the user actually requested. Ask before any write action such as sending a message or commenting.

## Server Operations

\`\`\`bash
direxio use <service-id>
direxio status --service <service-id> --json
direxio update --service <service-id> --image direxio/message-server:<tag> --json
direxio verify runtime --service <service-id> --json
direxio connect status --service <service-id> --json
direxio connect logs --service <service-id> --lines 120
direxio reset-app-data --service <service-id> --confirm --json
direxio destroy --service <service-id> --json
\`\`\`

\`status\` is the first read-only check for server state, phase progress, redacted resource ids, and local runtime evidence. \`update --image\` restarts the backend image in place without recreating Lightsail/EC2, DNS, fixed IP, or Docker volumes; run \`verify runtime\` afterward. \`reset-app-data\` preserves the cloud instance, fixed IP, DNS, and TLS volumes but clears app data and stale local credentials; expect fresh bootstrap credentials and local wiring afterward. \`destroy\` releases recorded cloud resources and removes the service-scoped local runtime files; it does not remove purchased domains or third-party DNS records.

Use \`--agent-install recommend\` only when the user wants files and commands without installing daemons. Use \`--agent-install skip\` only when the user wants credentials/config artifacts without local install.

Run command-specific help when unsure: \`direxio deploy --help\`, \`direxio status --help\`, \`direxio update --help\`, \`direxio reset-app-data --help\`, \`direxio destroy --help\`, \`direxio connect --help\`, and \`direxio mcp --help\`.

Successful deploy output includes \`init_password\`, the one-time app initialization password users enter before setting their own password. Do not print Matrix access tokens, agent tokens, AWS secrets, private keys, or full credential files. Use \`direxio status --json\`, \`direxio mcp doctor --json\`, and other redacted reports for machine-readable state.
`;
}
