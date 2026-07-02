# @direxio/cli

Unified command surface for deploying Direxio, wiring the local connect bridge,
exposing MCP tools, and installing agent-facing skills.

## Install

```bash
npm install -g @direxio/cli
```

## Commands

```bash
direxio --help
direxio skill --help
direxio deploy --help
direxio update --help
direxio mcp --help
direxio onboard aws
direxio aws import-csv <aws-access-key.csv> --profile direxio-deployer --region <aws-region>
direxio aws verify --profile direxio-deployer
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --cloud <confirmed-cloud> --dns auto --agent-install auto --confirm-domain --confirm-deploy
direxio status --service <service-id>
direxio update --service <service-id>
direxio reset-app-data --service <service-id> --confirm
direxio destroy --service <service-id>

direxio agents list
direxio agents check --agent codex

direxio connect install --service <service-id>
direxio connect status --service <service-id>

direxio mcp install --service <service-id> --target codex
direxio mcp status --service <service-id>
direxio mcp tools
direxio mcp call list_messages --service <service-id> --json '{"limit":20}'

direxio verify runtime --service <service-id>
direxio skill install --agent codex
```

Deploy first prints a confirmation checklist and exits with code `2` unless `--confirm-deploy` or `--yes` is present. The checklist queries AWS Free Tier, Lightsail bundles, and Lightsail availability zones before selecting a cloud. Lightsail is the default and uses the $12/month Linux bundle; if the default Lightsail AZ is unavailable, another available Lightsail AZ is selected. If Lightsail has no usable bundle or AZ in the region, the checklist selects EC2 and the confirm command includes `--cloud ec2`.

Successful deploy output includes `init_password`, the one-time app initialization password users enter before setting their own password. Status and operation reports continue to redact the password. Deploy progress is streamed to stderr as `[deploy] ...` lines so JSON stdout remains parseable.

Use `--cloud ec2` only when EC2-specific networking or instance controls are required, or when the confirmation checklist selected it. New EC2 deployments use a 50 GiB gp3 root EBS volume by default. `--dns auto` is also the default. A matching public Route53 hosted zone is used automatically; otherwise `direxio` records the user-managed DNS A record and exits with code `2` until the domain resolves to the fixed public IP. `--agent-install auto` installs and verifies connect/MCP by default; `recommend` writes files and next commands; `skip` writes credentials/config only.

Agent support is provider-plugin based. `direxio agents list` prints the provider-owned skill path, connect type, MCP snippets, and required binaries. `direxio agents check --agent <provider>` probes the selected provider executable before runtime verification claims the local agent side is usable. Supported providers: `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.

## Agent Skill Bootstrap

Paste this single instruction into an agent when you want it to install Direxio support for its own runtime:

```text
Install the Direxio skill for this agent: run `npx -y @direxio/cli@latest --help`, then `npx -y @direxio/cli@latest skill --help`, run `npx -y @direxio/cli@latest agents list --json`, choose the provider that matches this runtime, run `npx -y @direxio/cli@latest skill install --agent <provider> --json`, and read the generated `SKILL.md` before deploying or using Direxio.
```

Use only the current agent provider, not every provider. Common provider values:

```bash
npx -y @direxio/cli@latest skill install --agent codex --json
npx -y @direxio/cli@latest skill install --agent cursor --json
npx -y @direxio/cli@latest skill install --agent gemini --json
npx -y @direxio/cli@latest skill install --agent claudecode --json
```

If `direxio` is already installed globally, the equivalent command is `direxio skill install --agent <provider> --json`. Use `direxio skill --help` whenever the agent needs to rediscover the bootstrap flow. The generated skill is intentionally a compact runbook: it tells the agent how to inspect `direxio --help`, use command-specific help such as `direxio deploy --help` and `direxio update --help`, deploy with the confirmation checklist, verify runtime readiness, wire `direxio-connect`, install MCP snippets, run one read-only `search_rooms` MCP smoke, and operate the server with status, backend image update, app-data reset, and destroy commands.

MCP client snippets are service-scoped and should be installed after a service exists with `direxio mcp install --service <service-id> --target <provider>`.

`direxio` is the orchestration CLI. The long-running bridge stays in
`direxio-connect`, and MCP protocol serving stays in `direxio-mcp`.
