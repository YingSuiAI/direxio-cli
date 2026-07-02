import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "codex",
  label: "Codex",
  skillPath: [".codex", "skills", "direxio"],
  requiredBinaries: ["codex"],
  commandEnv: "DIREXIO_CODEX_COMMAND",
  defaultOptionsToml: 'backend = "app_server"\napp_server_url = "stdio"\nmode = "yolo"',
  mcpConfigFiles: ["codex.toml"]
});
