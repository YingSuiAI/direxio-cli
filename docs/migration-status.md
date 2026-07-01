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
- Connect daemon management slice:
  - `direxio connect status --service <service_id> --json`
  - `direxio connect logs --service <service_id> -n <lines>`
  - `direxio connect restart --service <service_id> --json`
  - commands invoke `direxio-connect daemon ... --service-name <service_id>` and fail if the underlying command fails.

Verified by:

```bash
npm test
npm run typecheck
```

## Not Complete Yet

These modules are not migrated and must not be reported as complete:

- `direxio deploy`
- `direxio status`
- `direxio destroy`
- `direxio update`
- `direxio reset-app-data`
- `direxio verify runtime`
- `direxio confirm app-initialization`
- `direxio connect install`
- `direxio mcp install/proxy`
- `direxio skill install/update/refresh`
- compatibility wrappers for existing shell and PowerShell entrypoints

Current unimplemented command paths exit with a non-zero status and explicit "planned but not implemented" messaging. That is intentional until each module is migrated with local tests.
