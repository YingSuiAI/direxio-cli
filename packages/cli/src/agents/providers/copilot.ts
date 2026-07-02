import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "copilot",
  label: "GitHub Copilot",
  skillPath: [".github", "copilot", "skills", "direxio"],
  requiredBinaries: ["gh"],
  commandEnv: "DIREXIO_COPILOT_COMMAND"
});
