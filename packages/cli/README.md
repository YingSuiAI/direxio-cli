# @direxio/cli

Unified command surface for deploying Direxio, wiring the local connect bridge,
exposing MCP tools, and installing agent-facing skills.

## Install

```bash
npm install -g @direxio/cli
```

## Commands

```bash
direxio onboard aws
direxio aws import-csv <aws-access-key.csv> --profile direxio-deployer --region <aws-region>
direxio aws verify --profile direxio-deployer
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain
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

`--dns auto` is the default. A matching public Route53 hosted zone is used automatically; otherwise `direxio` records the user-managed DNS A record and exits with code `2` until the domain resolves. `--agent-install auto` installs and verifies connect/MCP by default; `recommend` writes files and next commands; `skip` writes credentials/config only.

Agent support is provider-plugin based. `direxio agents list` prints the provider-owned skill path, connect type, MCP snippets, and required binaries. `direxio agents check --agent <provider>` probes the selected provider executable before runtime verification claims the local agent side is usable. Supported providers: `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.

`direxio` is the orchestration CLI. The long-running bridge stays in
`direxio-connect`, and MCP protocol serving stays in `direxio-mcp`.
