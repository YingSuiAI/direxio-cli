# @direxio/cli

Unified command surface for deploying Direxio, wiring the local connect bridge,
exposing MCP tools, and installing agent-facing skills.

## Install

```bash
npm install -g @direxio/cli
```

## Commands

```bash
direxio deploy --service <service-id> --domain <domain> --region <aws-region> --confirm-domain
direxio status --service <service-id>
direxio update --service <service-id>
direxio reset-app-data --service <service-id> --confirm
direxio destroy --service <service-id>

direxio connect install --service <service-id>
direxio connect status --service <service-id>

direxio mcp install --service <service-id> --target codex
direxio mcp status --service <service-id>
direxio mcp tools
direxio mcp call list_messages --service <service-id> --json '{"limit":20}'

direxio verify runtime --service <service-id>
direxio skill install --agent codex
```

`direxio` is the orchestration CLI. The long-running bridge stays in
`direxio-connect`, and MCP protocol serving stays in `direxio-mcp`.
