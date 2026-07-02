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

## Message And Channel Operations

Prefer MCP tools for business actions after a service is wired. Discover tools first:

\`\`\`bash
direxio mcp tools --json
direxio mcp call list_contacts --service <service-id> --json '{"limit":20}'
direxio mcp call search_rooms --service <service-id> --json '{"query":"alice","type":"all","limit":20}'
direxio mcp call list_messages --service <service-id> --json '{"room_id":"!room:id","limit":20}'
direxio mcp call send_message --service <service-id> --json '{"room_id":"!room:id","msg":"hello"}'
direxio mcp call list_room_members --service <service-id> --json '{"room_id":"!room:id","limit":50}'
direxio mcp call list_channel_posts --service <service-id> --json '{"room_id":"!channel:id","limit":20}'
direxio mcp call list_post_comments --service <service-id> --json '{"post_id":"<post-id>","limit":20}'
direxio mcp call comment_channel_post --service <service-id> --json '{"post_id":"<post-id>","msg":"comment text"}'
\`\`\`

When \`room_id\` is omitted for \`send_message\` or \`list_messages\`, the service agent room is used if available. Ask the user before sending or commenting when intent, recipient, or content is ambiguous.

## Operations

\`\`\`bash
direxio use <service-id>
direxio status --service <service-id> --json
direxio update --service <service-id> --json
direxio reset-app-data --service <service-id> --confirm --json
direxio destroy --service <service-id> --json
\`\`\`

Use \`--agent-install recommend\` only when the user wants files and commands without installing daemons. Use \`--agent-install skip\` only when the user wants credentials/config artifacts without local install.

Never print Matrix access tokens, agent tokens, initialization codes, AWS secrets, private keys, or full credential files. Use \`direxio status --json\`, \`direxio mcp doctor --json\`, and other redacted reports for machine-readable state.
`;
}
