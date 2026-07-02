import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "gemini",
  label: "Gemini CLI",
  skillPath: [".gemini", "skills", "direxio"],
  requiredBinaries: ["gemini"],
  commandEnv: "DIREXIO_GEMINI_COMMAND",
  mcpConfigFiles: ["gemini.mcp.json"]
});
