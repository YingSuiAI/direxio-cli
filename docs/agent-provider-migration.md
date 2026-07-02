# Agent Provider Migration

Rows are checked only when the provider behavior is implemented, covered by tests, and described in docs. Live client smoke is separate from implementation because it depends on installed local agent clients and login state.

| Provider | Registry | Skill | MCP | Connect | Verify | Live Smoke |
| --- | --- | --- | --- | --- | --- | --- |
| `acp` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `antigravity` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `claudecode` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `codex` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `copilot` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `cursor` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `devin` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `gemini` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `iflow` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `kimi` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `opencode` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `pi` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `qoder` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `reasonix` | [x] | [x] | [x] | [x] | [x] | [ ] |
| `tmux` | [x] | [x] | [x] | [x] | [x] | [ ] |

## Completion Rules

- Registry: provider resolves by id and aliases with complete metadata.
- Skill: `direxio skill install --agent <provider>` writes the provider-owned skill path.
- MCP: `direxio mcp install --target <provider>` writes provider-owned MCP artifacts.
- Connect: deploy local wiring uses provider-owned connect type and defaults.
- Verify: `direxio verify runtime` records selected provider metadata and probes required local binaries.
- Live Smoke: a real installed client was checked locally; this is not inferred from unit tests.
