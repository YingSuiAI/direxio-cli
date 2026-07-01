# Connect Runtime Package

Integration contract for `direxio-connect`.

Responsibilities:

- generate service-scoped Matrix bridge config;
- install, restart, inspect, and verify the connect daemon;
- detect or accept explicit local agent runtime selection;
- report bridge readiness and local agent startup failures.

The implementation may call the Go `direxio-connect` binary or import shared release metadata. It should not own deployment state or MCP tool schemas.
