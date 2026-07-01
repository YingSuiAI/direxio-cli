# MCP Runtime Package

Integration contract for `direxio-mcp`.

Responsibilities:

- install and verify the service-scoped MCP daemon;
- expose Streamable HTTP and stdio proxy entrypoints;
- support direct CLI tool calls for agent skills;
- generate MCP host snippets for Codex, Cursor, OpenClaw, Hermes, and generic MCP clients.

MCP remains a separate runtime so it can track the official MCP SDK without coupling the bridge daemon to MCP protocol internals.
