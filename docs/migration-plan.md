# Direxio Unified CLI Migration Plan

## Goal

Migrate the current Direxio deployer, local bridge wiring, MCP runtime access, and agent skill installation workflow into one product command: `direxio`.

Completion means users and agent skills can complete the current deployer-supported workflows without directly calling shell phase scripts, hand-editing generated MCP snippets, or manually composing local bridge environment variables.

## Target Product

The final command surface is:

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

## Architecture

Use a TypeScript CLI as the product orchestration layer. Keep `direxio-connect` as the Go runtime for Matrix bridge and local agent daemon behavior. Keep `direxio-mcp` as the TypeScript MCP runtime using the official MCP SDK. The CLI owns service context, local paths, state/report schemas, deployment orchestration, runtime installation, and skill-facing commands.

The product is unified at the command, service-context, and documentation level. Runtime implementations remain separate behind narrow interfaces.

## Migration Workstreams

1. CLI foundation:
   - Create a Node 20+ TypeScript workspace.
   - Publish a `direxio` bin from `packages/cli`.
   - Add command routing, JSON output, exit-code discipline, and tests.

2. Service context:
   - Resolve `--service <service_id>` first.
   - Fall back to the active service selected by `direxio use <service_id>`.
   - Load credentials from `~/.direxio/nodes/<service_id>/credentials.json`.
   - Never print tokens or full credential content.

3. MCP migration:
   - Port `direxio-mcp` tool schema/action mapping into a reusable module.
   - Implement `direxio mcp doctor`, `direxio mcp tools`, and `direxio mcp call`.
   - Keep HTTP daemon and stdio proxy support for MCP host registration.
   - Generate host snippets through `direxio mcp install --target <runtime>`.

4. Connect migration:
   - Implement `direxio connect install/status/logs/restart`.
   - Manage `direxio-connect` config, daemon lifecycle, and readiness checks.
   - Report Matrix bridge status and local agent backend failures through one status model.

5. Deploy migration:
   - Port S0-S7 state machine from shell to TypeScript modules.
   - Preserve resumability, waiting-user states, recovery summaries, billing warnings, and redacted operation reports.
   - Keep remote EC2 paths Linux-only and local bridge paths host-native.
   - Preserve DNS policies: `auto` uses public Route53 when available and otherwise waits for user-managed DNS; explicit Route53 overwrites require confirmation.
   - Preserve local install policies: `auto`, `recommend`, and `skip`.

6. Skill migration:
   - Port npm-managed skill install/update/refresh into `direxio skill`.
   - Update skill docs so agents call `direxio` commands only.
   - Remove dependency on shell phase internals from agent-facing instructions.

7. Compatibility wrappers:
   - Keep existing shell/PowerShell entrypoints as thin wrappers only.
   - Wrappers must call `direxio` and preserve current user-facing command behavior.

## Completion Criteria

- `direxio deploy` can perform the current production EC2 deployment and local wiring flow, including DNS auto/user/Route53 behavior and post-install runtime verification.
- `direxio destroy`, `update`, and `reset-app-data` cover the current resource and local-daemon cleanup rules.
- `direxio connect` covers service-scoped daemon install/status/logs/restart.
- `direxio mcp` covers doctor, tools, direct tool calls, HTTP endpoint, stdio proxy, and host snippet installation.
- `direxio skill` covers all supported agent targets currently documented by the deployer.
- Existing deployer validation scenarios have equivalent tests in the new workspace.
- `codegraph` indexes the new codebase after code files exist.
- The old scripts are either replaced by wrappers or removed after equivalent behavior is verified.

## Current First Slice

The first executable slice migrates service context and direct MCP CLI calls. This gives skills a stable command interface before the larger deploy/connect migration lands.
