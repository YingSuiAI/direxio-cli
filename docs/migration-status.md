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
  - runtime verification writes `runtime_checks.agent_provider`, `runtime_checks.connect_daemon`, `runtime_checks.mcp_daemon`, `runtime_checks.mcp_doctor`, `runtime_checks.mcp_tools`, `runtime_checks.mcp_smoke`, and `runtime_checks.summary` into `state.json`.
  - `runtime_checks.agent_provider` resolves the selected provider plugin and probes required local binaries before reporting the agent side usable.
  - confirmation writes `user_confirmations` into `state.json`; `agent-mcp-runtime` requires `runtime_checks.summary.status=passed` plus runtime probe confirmation.
- Existing node operations slice:
  - `direxio update --service <service_id> --json`
  - `direxio reset-app-data --service <service_id> --confirm --json`
  - `direxio destroy --service <service_id> --json`
  - update runs the migrated remote Docker Compose pull/up command over SSH and writes `operation-report.json` without clearing local confirmations or runtime checks.
  - reset requires explicit confirmation, runs the migrated remote data-reset command over SSH, stops only the matching service-scoped `direxio-connect` daemon, clears stale credentials/confirmations/runtime checks, and marks local wiring phases refresh-pending.
  - destroy stops only the matching service-scoped `direxio-connect` daemon, removes recorded EC2/EIP/security-group/key-pair/Route53 resources through AWS CLI commands, writes a redacted destroy report under `~/.direxio/reports/<service_id>/operation-report.json`, then removes the local service directory.
- Skill installation slice:
  - `direxio skill install --agent <runtime> --json`
  - `direxio skill update --agent <runtime> --json`
  - `direxio skill refresh --agent <runtime> --json`
  - writes a compact agent-facing `direxio` skill into the provider-owned global skill directory and points agents at the unified CLI instead of legacy shell phase scripts.
- Agent provider plugin slice:
  - `direxio agents list --json`
  - `direxio agents check --agent <provider> --json`
  - provider registry owns aliases, skill paths, connect defaults, command override env vars, MCP snippet files, and verification requirements for `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.
  - `direxio agents check` honors `DIREXIO_CONNECT_AGENT_CMD` and provider-specific command overrides, then probes availability with Windows `where.exe` or POSIX `command -v`.
- Compatibility wrapper slice:
  - `scripts/orchestrate.sh` and `scripts/orchestrate.ps1` forward to `direxio deploy` by default or pass explicit arguments through to `direxio`.
  - `scripts/destroy.sh` and `scripts/destroy.ps1` forward to `direxio destroy`.
  - wrappers do not contain deployment logic; the product implementation lives in the TypeScript CLI.
- Deploy and local wiring slice:
  - `direxio onboard aws --json`
  - `direxio aws import-csv <aws-access-key.csv> --profile <profile> --region <aws-region> --json`
  - `direxio aws verify --profile <profile> --json`
  - `direxio deploy --service <service_id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain --json`
  - deploy validates confirmed production-domain intent, creates or resumes service-scoped state under `~/.direxio/nodes/<service_id>/`, resolves the Ubuntu 22.04 AMI through AWS SSM, creates EC2/security-group/key-pair/EIP resources, uses a matching public Route53 hosted zone when one exists, otherwise records the required user-managed DNS A record and waits with exit code `2`, writes cloud-init user-data, waits for `https://<domain>/healthz`, pulls bootstrap credentials over SSH, creates an agent Matrix session through `agent.matrix_session.create`, writes `credentials.json`, generates `direxio-connect/config.toml`, installs the service-scoped `direxio-connect` daemon, installs `direxio-mcp`, writes MCP target snippets, then requires runtime verification to pass before marking deploy complete.
  - resume skips already recorded AWS resources to avoid duplicate security groups, key pairs, EC2 instances, EIPs, or hosted zones, while still refreshing health/bootstrap/local wiring.
  - DNS overwrite protection blocks Route53 A record replacement until `--confirm-dns-overwrite` or `DIREXIO_CONFIRM_DNS_OVERWRITE=1`.
  - `--agent-install auto` is the default; `recommend` writes files, snippets, and next commands without starting daemons; `skip` writes credentials/config only.
  - state records billing warnings for EC2/EBS/public IPv4/Elastic IP/Route53 resources and reports user-managed DNS A record instructions when needed.
  - cloud-init starts the migrated production stack: PostgreSQL 18, Direxio message-server, Caddy, and coturn with TURN ports `3478` tcp/udp plus `49160-49200` udp.
  - S6 connect config generation uses the Matrix `@agent:<server>` session token and restricts the Matrix platform to the real `agent_room_id`; MCP snippets call `direxio mcp proxy --service <service_id>`.
  - S7 runtime verification checks connect daemon ownership/logs, MCP daemon status, MCP tool discovery, and a read-only backend smoke call before deploy success.
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
  - `direxio mcp install --service <service_id> --target <provider|json|all> --json`
  - command runs `npm install -g direxio-mcp@latest`, then `direxio-mcp daemon install --service-name <service_id> --credentials-file <credentials.json> --host 127.0.0.1 --port 19757`.
  - `direxio mcp proxy` runs `direxio-mcp proxy --url http://127.0.0.1:19757/mcp`; direct CLI execution uses inherited stdio for MCP clients.
  - target installs generate provider-owned host snippets under `~/.direxio/nodes/<service_id>/mcp/` using `direxio mcp proxy --service <service_id>` as the client entrypoint.
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

## Remaining Follow-Up

- Replace shell compatibility wrappers in downstream packaging only after consumers install the `direxio` package directly.
- Exercise one real cloud deployment before publishing a release; local tests cover command contracts and generated artifacts but do not create AWS resources.
- Follow up on pricing/free-tier and Elastic IP quota preflight if the product should block risky AWS accounts before resource creation.
