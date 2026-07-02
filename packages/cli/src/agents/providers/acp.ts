import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "acp",
  label: "ACP-compatible Agent",
  aliases: ["openclaw", "hermes"],
  skillPath: [".agents", "skills", "direxio"],
  agentType: "acp",
  requiredBinaries: ["npx"],
  commandEnv: "DIREXIO_ACP_COMMAND",
  mcpConfigFiles: ["acp.mcp.json", "openclaw-server.json", "hermes.mcp.json"]
});
