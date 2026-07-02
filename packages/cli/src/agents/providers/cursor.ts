import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "cursor",
  label: "Cursor",
  skillPath: [".cursor", "skills", "direxio"],
  requiredBinaries: ["cursor"],
  commandEnv: "DIREXIO_CURSOR_COMMAND",
  mcpConfigFiles: ["cursor.mcp.json"]
});
