import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "opencode",
  label: "OpenCode",
  skillPath: [".opencode", "skills", "direxio"],
  requiredBinaries: ["opencode"],
  commandEnv: "DIREXIO_OPENCODE_COMMAND"
});
