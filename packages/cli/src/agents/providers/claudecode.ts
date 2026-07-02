import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "claudecode",
  label: "Claude Code",
  aliases: ["claude", "claude-code"],
  skillPath: [".claude", "skills", "direxio"],
  requiredBinaries: ["claude"],
  commandEnv: "DIREXIO_CLAUDE_CODE_COMMAND",
  mcpConfigFiles: ["claudecode.mcp.json"]
});
