# Migration Gap Audit

This audit compares the old deployer expectations against the unified `direxio` CLI product. It records module-level coverage so missing behavior is visible before future work starts.

## DNS And Domain

- Status: migrated in this round.
- Current behavior: `--dns auto` is the default. The CLI checks for a matching public Route53 hosted zone. If found, it uses Route53. If not found, it switches to user-managed DNS, records `<domain> A <public_ip>`, marks S3 as `waiting_user`, and exits with code `2` until DNS resolves.
- Safety: existing Route53 A records pointing elsewhere require `--confirm-dns-overwrite` or `DIREXIO_CONFIRM_DNS_OVERWRITE=1`.
- Destroy behavior: `domain_mode=user` never deletes or mutates Route53 records, even if historical state has Route53 fields.

## AWS Onboarding And Credentials

- Status: migrated in this round.
- Current behavior: `direxio onboard aws` explains the root-key and temporary IAM-user paths. `direxio aws import-csv` imports an AWS access-key CSV into a named profile and verifies it with STS. `direxio aws verify` reports the caller identity with the account redacted and flags root credentials.
- Safety: command output does not include access keys or secret keys.

## AWS Resource Provisioning

- Status: mostly migrated.
- Current behavior: deploy resolves Ubuntu 22.04 AMI through SSM, creates security group/key pair/EC2/EIP resources, records billable resources, and resumes from existing state without duplicate resources.
- Remaining follow-up: pricing/free-tier guardrails and Elastic IP quota preflight are not yet blocking checks. They should be added if the product must fail before resource creation on risky AWS accounts.

## Remote Server Bootstrap

- Status: migrated.
- Current behavior: cloud-init renders the production stack, healthz is required, bootstrap credentials are pulled over SSH, and the Matrix agent session uses `agent_token`.
- Safety: generated reports redact initialization codes, Matrix tokens, agent tokens, AWS secrets, and private keys.

## Local Connect Wiring

- Status: migrated in this round.
- Current behavior: `--agent-install auto` is the default and installs `direxio-connect`; `recommend` writes files and next commands without starting daemons; `skip` writes credentials/config only.
- Verification: auto install requires runtime verification to pass before deploy completes. Connect verification checks daemon ownership, expected work directory, readiness logs, and local agent backend errors.

## MCP Runtime

- Status: migrated in this round.
- Current behavior: deploy writes MCP host snippets, installs `direxio-mcp` in auto mode, exposes `direxio mcp proxy`, and supports direct `direxio mcp call`.
- Verification: runtime verification now checks MCP daemon status, tool discovery, and a read-only `mcp.messages.list` smoke call before auto deploy success.

## Existing Node Operations

- Status: migrated.
- Current behavior: `status`, `update`, `reset-app-data`, and `destroy` operate against the service context under `~/.direxio/nodes/<service_id>/`.
- Safety: destroy only stops the matching service-scoped connect daemon and skips user-managed DNS cleanup.

## Skill And Agent Surface

- Status: migrated.
- Current behavior: built-in agent provider plugins own each platform's skill path, connect type/defaults, MCP snippets, command override env vars, aliases, and verification requirements. `direxio agents list` reports the plugin matrix. `direxio agents check --agent <provider>` probes local executable availability before runtime verification marks the provider usable.
- Skill behavior: `direxio skill install|update|refresh --agent <runtime>` writes agent-facing `SKILL.md` files that point to `direxio` commands instead of legacy phase scripts.
- MCP behavior: `direxio mcp install --target <provider>` writes only the selected provider's MCP snippets; `--target all` writes every provider artifact.
- Connect behavior: deploy local wiring resolves the selected provider and writes provider-owned connect defaults, including special options such as `reasonix.serve_url` and `tmux.session`.
- Supported targets: `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, and `tmux`.
