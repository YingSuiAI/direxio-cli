# Direxio CLI

Unified local product surface for deploying Direxio, wiring the Matrix agent bridge, exposing MCP tools, and installing agent-facing skills.

## Product Shape

`direxio` is the single command users and agent skills should call:

```bash
direxio deploy
direxio status --service <service-id>
direxio update --service <service-id>
direxio reset-app-data --service <service-id> --confirm
direxio destroy --service <service-id>
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

Internally, the product keeps deep modules:

- `packages/cli`: TypeScript orchestration CLI, deployment state, reports, paths, and skill commands.
- `packages/connect-runtime`: Go `direxio-connect` runtime integration for Matrix bridge and local agent daemon management.
- `packages/mcp-runtime`: TypeScript `direxio-mcp` runtime integration for MCP HTTP, stdio proxy, and direct CLI tool calls.

## Direction

The product is unified at the command and service-context level, not by forcing every runtime into one process or language. `direxio-connect` remains the long-running bridge runtime; `direxio-mcp` remains the MCP protocol runtime; `direxio` manages both.
