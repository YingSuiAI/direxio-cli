# Agent Provider Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all agent compatibility behavior into built-in Agent Provider modules and track each platform migration result.

**Architecture:** Add `packages/cli/src/agents/` as a deep module with a small provider registry interface. Existing CLI flows call the registry instead of hard-coded path, MCP, and connect tables. Provider implementations remain built-in and dynamically loaded.

**Tech Stack:** TypeScript ESM, Vitest, Node 20+, existing `direxio` CLI modules.

---

### Task 1: Provider Registry And Migration Matrix

**Files:**
- Create: `packages/cli/src/agents/types.ts`
- Create: `packages/cli/src/agents/registry.ts`
- Create: `packages/cli/src/agents/providers/*.ts`
- Create: `packages/cli/test/agents.test.ts`
- Create: `docs/agent-provider-migration.md`

- [ ] **Step 1: Write failing registry tests**

Add tests that assert all documented provider ids resolve, aliases map correctly, and every provider has skill, connect, MCP, and verify metadata.

- [ ] **Step 2: Implement provider types and registry**

Create `AgentProvider`, dynamic provider loaders, `resolveAgentProvider`, `listAgentProviders`, and alias handling.

- [ ] **Step 3: Add provider files**

Add one provider module for each target: `acp`, `antigravity`, `claudecode`, `codex`, `copilot`, `cursor`, `devin`, `gemini`, `iflow`, `kimi`, `opencode`, `pi`, `qoder`, `reasonix`, `tmux`.

- [ ] **Step 4: Add migration matrix**

Create `docs/agent-provider-migration.md` with one row per provider and unchecked boxes for implementation stages.

- [ ] **Step 5: Run tests**

Run `npm --workspace @direxio/cli run test -- test/agents.test.ts`.

### Task 2: Skill Installer Uses Providers

**Files:**
- Modify: `packages/cli/src/skill.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/skill.test.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Update: `docs/agent-provider-migration.md`

- [ ] **Step 1: Write failing skill tests**

Tests must cover all provider ids and aliases such as `claude` and `claude-code`.

- [ ] **Step 2: Make `installSkill` async and provider-backed**

Resolve provider metadata and write the provider's `SKILL.md` to `provider.skill.pathSegments`.

- [ ] **Step 3: Update CLI call sites**

Await `runSkill` and preserve JSON output shape.

- [ ] **Step 4: Mark skill column complete**

Check the skill column for every provider in `docs/agent-provider-migration.md`.

### Task 3: MCP Config Uses Providers

**Files:**
- Modify: `packages/cli/src/mcp-config.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/deploy.ts`
- Create: `packages/cli/test/mcp-config.test.ts`
- Update: `docs/agent-provider-migration.md`

- [ ] **Step 1: Write failing MCP artifact tests**

Tests must generate artifacts for every provider id and verify file names and `direxio mcp proxy --service <service_id>` command.

- [ ] **Step 2: Move artifact generation behind provider metadata**

Replace the hard-coded target switch in `mcp-config.ts` with provider-driven config file specs.

- [ ] **Step 3: Preserve existing aliases**

Keep `hermes`, `openclaw`, and `json` as compatibility targets, but make provider ids the primary path.

- [ ] **Step 4: Mark MCP column complete**

Check the MCP column for every provider with generated artifacts.

### Task 4: Connect Defaults Use Providers

**Files:**
- Modify: `packages/cli/src/connect.ts`
- Modify: `packages/cli/src/deploy.ts`
- Modify: `packages/cli/test/connect.test.ts`
- Modify: `packages/cli/test/deploy.test.ts`
- Update: `docs/agent-provider-migration.md`

- [ ] **Step 1: Write failing connect default tests**

Tests must show Codex defaults come from the Codex provider and at least `cursor`, `claudecode`, and `gemini` use provider-owned agent types and command defaults.

- [ ] **Step 2: Pass provider connect metadata into `writeConnectConfig`**

Remove provider-specific default behavior from `connect.ts`; keep `connect.ts` generic.

- [ ] **Step 3: Update deploy local wiring**

Resolve selected provider once and pass its connect metadata into `writeLocalWiring`.

- [ ] **Step 4: Mark connect column complete**

Check the connect column after tests pass.

### Task 5: Runtime Verification Records Provider Compatibility

**Files:**
- Modify: `packages/cli/src/verify.ts`
- Modify: `packages/cli/src/state.ts`
- Modify: `packages/cli/test/verify.test.ts`
- Modify: `packages/cli/test/state.test.ts`
- Update: `docs/agent-provider-migration.md`

- [ ] **Step 1: Write failing provider verify tests**

Tests must show selected provider id, required binaries, and supported checks are recorded.

- [ ] **Step 2: Add provider metadata to runtime checks**

`verifyRuntime` records `runtime_checks.agent_provider` before connect/MCP checks.

- [ ] **Step 3: Expose provider status in reports**

`status --json` includes provider id, label, required binaries, and verification status.

- [ ] **Step 4: Mark verify column complete**

Check the verify column for every provider.

### Task 6: Docs, Full Verification, Release

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/migration-status.md`
- Modify: `docs/agent-provider-migration.md`
- Modify: `packages/cli/package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Update docs**

Document `direxio agents list`, supported provider ids, aliases, MCP artifact paths, and complete/incomplete live verification scope.

- [ ] **Step 2: Run full verification**

Run `npm test`, `npm run typecheck`, `npm run build`, `git diff --check`, and `npm pack --workspace @direxio/cli --dry-run --json`.

- [ ] **Step 3: Bump patch version and publish**

Publish the new patch version after all tests and docs pass.

- [ ] **Step 4: Commit and tag**

Commit with a focused message, push `master`, tag the release, and push the tag.
