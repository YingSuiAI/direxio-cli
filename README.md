# Direxio CLI

Unified local product surface for deploying Direxio, wiring the Matrix agent bridge, exposing MCP tools, and installing agent-facing skills.

## Product Shape

`direxio` is the single command users and agent skills should call:

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
direxio connect status
direxio mcp install --service <service-id> --target codex
direxio mcp status --service <service-id>
direxio mcp doctor
direxio mcp proxy
direxio mcp call list_messages --json '{"limit":20}'
direxio verify runtime --service <service-id>
direxio confirm app-initialization --service <service-id> --evidence "user completed initialization"
direxio skill install --agent codex
```

Deploy uses `--dns auto` by default: if the AWS account has a matching public Route53 hosted zone, `direxio` writes the A record there; otherwise it records the required user-managed DNS A record and exits with code `2` until the domain resolves to the Elastic IP. `--agent-install auto` is also the default. Use `--agent-install recommend` to write files and print install commands, or `--agent-install skip` to write credentials/config only.

Agent compatibility is implemented through built-in provider plugins. `direxio agents list` shows each provider's skill path, connect type, MCP config files, and required local binaries. `direxio agents check --agent <provider>` and `direxio verify runtime` probe the selected provider's executable dependencies before claiming the runtime is usable. Supported providers are `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.

## Agent Skill Bootstrap

Paste this single instruction into an agent when you want it to install Direxio support for its own runtime:

```text
Install the Direxio skill for this agent: run `npx -y @direxio/cli@latest agents list --json`, choose the provider that matches this runtime, then run `npx -y @direxio/cli@latest skill install --agent <provider> --json` and read the generated `SKILL.md` before using Direxio.
```

Use only the current agent provider, not every provider. Common provider values:

```bash
npx -y @direxio/cli@latest skill install --agent codex --json
npx -y @direxio/cli@latest skill install --agent cursor --json
npx -y @direxio/cli@latest skill install --agent gemini --json
npx -y @direxio/cli@latest skill install --agent claudecode --json
```

If `direxio` is already installed globally, the equivalent command is `direxio skill install --agent <provider> --json`. MCP client snippets are service-scoped and should be installed after a service exists with `direxio mcp install --service <service-id> --target <provider>`.

Internally, the product keeps deep modules:

- `packages/cli`: TypeScript orchestration CLI, deployment state, reports, paths, and skill commands.
- `packages/connect-runtime`: Go `direxio-connect` runtime integration for Matrix bridge and local agent daemon management.
- `packages/mcp-runtime`: TypeScript `direxio-mcp` runtime integration for MCP HTTP, stdio proxy, and direct CLI tool calls.

## Direction

The product is unified at the command and service-context level, not by forcing every runtime into one process or language. `direxio-connect` remains the long-running bridge runtime; `direxio-mcp` remains the MCP protocol runtime; `direxio` manages both.
