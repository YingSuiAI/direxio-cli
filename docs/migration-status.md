# Migration Status

This file records verified migration progress. A module is marked complete only when local tests cover its migrated behavior and the command surface is implemented without placeholder success.

## Completed In This Workspace

- CLI workspace foundation:
  - `package.json` workspace scripts exist for build, test, and typecheck.
  - `packages/cli` builds as a TypeScript Node package with a `direxio` bin.
- Service context:
  - `--service <service_id>` resolves credentials under `~/.direxio/nodes/<service_id>/credentials.json`.
  - deployer credential shape is loaded.
  - token values are used internally but not printed by doctor output.
- State, status, and confirmation slice:
  - `direxio status --service <service_id> --json`
  - `direxio verify runtime --service <service_id> --json`
  - `direxio confirm app-initialization --service <service_id> --evidence <text> --json`
  - `direxio confirm real-chat --service <service_id> --evidence <text> --json`
  - `direxio confirm agent-mcp-runtime --service <service_id> --evidence <text> --runtime-probe --json`
  - status uses the migrated operation-report model and redacts initialization codes, Matrix tokens, agent tokens, and AWS session secrets.
  - runtime verification writes `runtime_checks.connect_daemon`, `runtime_checks.mcp_doctor`, `runtime_checks.mcp_tools`, `runtime_checks.mcp_smoke`, and `runtime_checks.summary` into `state.json`.
  - confirmation writes `user_confirmations` into `state.json`; `agent-mcp-runtime` requires `runtime_checks.summary.status=passed` plus runtime probe confirmation.
- Existing node operations slice:
  - `direxio update --service <service_id> --json`
  - `direxio reset-app-data --service <service_id> --confirm --json`
  - `direxio destroy --service <service_id> --json`
  - update runs the migrated remote Docker Compose pull/up command over SSH and writes `operation-report.json` without clearing local confirmations or runtime checks.
  - reset requires explicit confirmation, runs the migrated remote data-reset command over SSH, stops only the matching service-scoped `direxio-connect` daemon, clears stale credentials/confirmations/runtime checks, and marks local wiring phases refresh-pending.
  - destroy stops only the matching service-scoped `direxio-connect` daemon, removes recorded EC2/EIP/security-group/key-pair/Route53 resources through AWS CLI commands, writes a redacted destroy report under `~/.direxio/reports/<service_id>/operation-report.json`, then removes the local service directory.
- MCP direct CLI slice:
  - `direxio mcp doctor --service <service_id> --json`
  - `direxio mcp tools --json`
  - `direxio mcp call <tool-name> --service <service_id> --json '<input-json>'`
  - migrated tool contracts: `list_contacts`, `search_rooms`, `send_message`, `list_messages`, `list_room_members`, `list_channel_posts`, `list_post_comments`, `comment_channel_post`.
  - `list_messages` defaults to the service agent room when no `room_id` is passed.
  - `send_message` refuses to target the service agent room.
- MCP daemon status slice:
  - `direxio mcp status --service <service_id> --json`
  - command invokes `direxio-mcp daemon status --service-name <service_id> --json` and fails if the underlying command fails.
- MCP daemon install/proxy slice:
  - `direxio mcp install --service <service_id> --json`
  - command runs `npm install -g direxio-mcp@latest`, then `direxio-mcp daemon install --service-name <service_id> --credentials-file <credentials.json> --host 127.0.0.1 --port 19757`.
  - `direxio mcp proxy` runs `direxio-mcp proxy --url http://127.0.0.1:19757/mcp`; direct CLI execution uses inherited stdio for MCP clients.
  - `direxio mcp install --target <runtime>` is still blocked with a non-zero status because host snippet generation is not migrated yet.
- Connect daemon management slice:
  - `direxio connect install --service <service_id> --json`
  - `direxio connect status --service <service_id> --json`
  - `direxio connect logs --service <service_id> -n <lines>`
  - `direxio connect restart --service <service_id> --json`
  - install requires an existing `~/.direxio/nodes/<service_id>/direxio-connect/config.toml`, runs `npm install -g direxio-connent@latest`, installs the service-scoped daemon, and verifies startup through daemon status plus logs.
  - commands invoke `direxio-connect daemon ... --service-name <service_id>` and fail if the underlying command fails.

Verified by:

```bash
npm test
npm run typecheck
```

## Not Complete Yet

These modules are not migrated and must not be reported as complete:

- `direxio deploy`
- `direxio mcp install --target <runtime>`
- connect config generation during deploy/S6 wiring
- `direxio skill install/update/refresh`
- compatibility wrappers for existing shell and PowerShell entrypoints

Current unimplemented command paths exit with a non-zero status and explicit "planned but not implemented" messaging. That is intentional until each module is migrated with local tests.
