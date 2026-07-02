# Agent Provider Plugins Design

## Goal

Refactor agent compatibility into built-in Agent Provider modules so each agent owns its skill installation target, MCP host snippet, connect defaults, dependency detection, runtime verification profile, tests, and migration status.

## Scope

The migration covers the currently documented local agent targets:

- [ ] `acp`
- [ ] `antigravity`
- [ ] `claudecode`
- [ ] `codex`
- [ ] `copilot`
- [ ] `cursor`
- [ ] `devin`
- [ ] `gemini`
- [ ] `iflow`
- [ ] `kimi`
- [ ] `opencode`
- [ ] `pi`
- [ ] `qoder`
- [ ] `reasonix`
- [ ] `tmux`

A platform is complete only when it has a provider module, skill install behavior, MCP config artifact behavior, connect defaults, dependency detection, runtime verification metadata, tests, and a checked row in the migration matrix.

## Architecture

Create a deep module at `packages/cli/src/agents/`. The external seam is intentionally small:

```ts
resolveAgentProvider(agent: string): Promise<AgentProvider>
listAgentProviders(): Promise<AgentProviderSummary[]>
detectAgentProvider(input): Promise<AgentDetectionResult>
```

Each provider is an adapter behind that seam. Callers stop knowing about platform-specific paths, aliases, MCP config filenames, connect defaults, or required binaries.

Provider modules are loaded through dynamic import loaders in `agents/registry.ts`. This keeps platform-specific code and future platform-specific dependencies out of the runtime path unless that provider is selected or listed.

## Provider Interface

```ts
export interface AgentProvider {
  id: AgentId;
  label: string;
  aliases: string[];
  skill: {
    pathSegments: string[];
  };
  connect: {
    agentType: string;
    defaultOptionsToml?: string;
    defaultCommandEnv?: string;
    requiredBinaries: string[];
  };
  mcp: {
    target: AgentId;
    configFiles: string[];
    supportsNativeMcp: boolean;
  };
  verify: {
    requiredBinaries: string[];
    checks: string[];
  };
}
```

## Data Flow

`direxio deploy --agent cursor` resolves the `cursor` provider once, then passes provider-derived values into local wiring. `direxio skill install --agent cursor` uses the same provider. `direxio mcp install --target cursor` resolves the target provider and writes the provider-owned MCP artifact. `direxio verify runtime --agent cursor` records provider metadata alongside existing connect and MCP checks.

## Error Handling

Unknown providers fail with a list of supported ids and aliases. Ambiguous detection must not choose a semantic default; it must ask for explicit `--agent`. Missing optional platform binaries are reported by `verify`, not by unrelated commands. Auto install still fails closed when runtime verification fails.

## Tests

Tests should exercise behavior through public CLI/module interfaces:

- Registry resolves ids and aliases.
- Every provider has required metadata.
- `skill install` writes each provider's skill to the expected path.
- MCP config generation writes each provider artifact without loading unrelated provider implementation.
- Deploy local wiring uses provider connect defaults.
- Runtime verification records selected provider metadata.
- Migration matrix stays synchronized with provider ids.

## Migration Matrix

The checked state lives in `docs/agent-provider-migration.md`. A row can be checked only after its provider tests pass and the docs describe the generated artifacts.
