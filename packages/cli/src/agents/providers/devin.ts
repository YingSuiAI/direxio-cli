import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "devin",
  label: "Devin",
  skillPath: [".devin", "skills", "direxio"],
  requiredBinaries: ["devin"],
  commandEnv: "DIREXIO_DEVIN_COMMAND"
});
