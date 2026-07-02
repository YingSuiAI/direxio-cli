import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "antigravity",
  label: "Antigravity",
  skillPath: [".antigravity", "skills", "direxio"],
  requiredBinaries: ["antigravity"],
  commandEnv: "DIREXIO_ANTIGRAVITY_COMMAND"
});
