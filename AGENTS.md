# AGENTS.md

This repository defines the unified Direxio CLI product. Keep instructions agent-facing and implementation rules in English.

## Product Rules

- `direxio` is the only command surface that skills should call directly.
- Do not make agent skills depend on shell phase scripts, generated local config paths, or raw environment variable wiring.
- Keep `direxio-connect` and `direxio-mcp` as runtime modules with clear interfaces. The product experience is unified; implementations do not need to be forced into one process.
- Local paths written for bridge or MCP consumers must use the host runtime path format. Remote server paths remain Linux paths.
- Never commit credentials, Matrix tokens, AWS secrets, `.codegraph/`, local daemon metadata, generated env files, or service state.

## Initial Architecture

- `packages/cli` owns deployment, status, destroy, update, reset, service context, reports, and skill installation.
- `packages/connect-runtime` owns the contract for installing and managing `direxio-connect`.
- `packages/mcp-runtime` owns the contract for MCP HTTP, stdio proxy, and `direxio mcp call`.
- `docs/architecture.md` is the source of truth for product boundaries until code exists.

## Validation

Before claiming work complete, run the closest available checks for the files changed. For documentation-only changes, run:

```bash
git diff --check
git status --short
```
