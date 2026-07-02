# Direxio CLI Architecture

## Summary

`direxio-cli` is the unified product layer for Direxio local operations. It replaces fragmented user and skill workflows with one command family while preserving the best implementation language for each runtime.

## Command Surface

```bash
direxio onboard aws
direxio aws import-csv <aws-access-key.csv>
direxio aws verify
direxio deploy --dns auto --agent-install auto
direxio status
direxio destroy
direxio update
direxio reset-app-data
direxio verify runtime
direxio confirm app-initialization

direxio agents list
direxio agents check --agent <provider>

direxio connect install
direxio connect status
direxio connect logs
direxio connect restart

direxio mcp install
direxio mcp status
direxio mcp doctor
direxio mcp tools
direxio mcp proxy
direxio mcp call <tool-name> --json '<input-json>'

direxio skill install --agent <runtime>
direxio skill update --agent <runtime>
direxio skill refresh --agent <runtime>
direxio use <service-id>
```

## Runtime Boundaries

`packages/cli` is a TypeScript CLI and orchestration module. It owns service selection, deployment state, redacted reports, path classification, AWS deployment orchestration, skill installation, and runtime wiring.

`packages/connect-runtime` is the integration layer for the Go `direxio-connect` runtime. It manages Matrix bridge config, daemon install/status/logs, agent runtime selection, and service-scoped bridge verification.

`packages/mcp-runtime` is the integration layer for the TypeScript `direxio-mcp` runtime. It manages MCP HTTP endpoint setup, stdio proxy config, tool discovery, direct CLI tool calls, and MCP host snippets.

## Agent Provider Plugins

Agent compatibility is modeled as built-in provider modules under `packages/cli/src/agents/providers/`. Each provider owns its skill path, connect agent type, command override env var, default connect TOML, MCP config files, aliases, and runtime verification requirements.

Supported providers are `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.

User-facing commands:

- `direxio agents list` lists every provider plugin and its owned artifacts.
- `direxio agents check --agent <provider>` probes the selected provider executable through the platform-native command lookup.
- `direxio skill install --agent <provider>` writes only that provider's skill.
- `direxio mcp install --target <provider>` writes only that provider's MCP snippets.
- `direxio deploy --agent <provider>` writes that provider's connect config defaults and records it in service state.
- `direxio verify runtime` checks `runtime_checks.agent_provider` before connect and MCP checks.

## MCP Strategy

MCP is soft-merged into the product. Users see one `direxio` product and one service context, while MCP remains an independent runtime behind a small interface.

Supported entrypoints:

- Streamable HTTP: `http://127.0.0.1:<port>/mcp`
- Stdio proxy: `direxio mcp proxy --service <service-id>`
- Direct skill command: `direxio mcp call <tool-name> --service <service-id> --json '<input-json>'`

This keeps MCP registrable in clients that require stdio, usable by clients that support HTTP, and callable by agent skills without exposing local credential paths.

## Service Context

All local service state lives under:

```text
~/.direxio/nodes/<service_id>/
```

The CLI resolves `--service <service_id>` first, then the active service selected by `direxio use <service_id>`. Skills should prefer explicit `--service` when they know the target service.

## Deployment Policies

DNS defaults to `auto`: use a matching public Route53 hosted zone when one exists in the AWS account; otherwise record the required user-managed A record and wait for DNS to resolve. Route53 A record overwrites require `--confirm-dns-overwrite`.

Local runtime install defaults to `auto`: install `direxio-connect` and `direxio-mcp`, then require runtime verification to pass before marking deploy complete. `recommend` writes files, MCP host snippets, and next commands without starting daemons. `skip` writes credentials and connect config only.

## Non-Goals

- Do not rewrite `direxio-connect` MCP behavior into Go unless a future protocol or packaging requirement makes it unavoidable.
- Do not expose owner tokens, Matrix session tokens, AWS secrets, or generated credential files through normal command output.
- Do not restore legacy local gateway flows or third-party chat-platform wiring in this product layer.
