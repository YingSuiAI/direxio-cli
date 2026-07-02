import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "kimi",
  label: "Kimi",
  skillPath: [".kimi", "skills", "direxio"],
  requiredBinaries: ["kimi"],
  commandEnv: "DIREXIO_KIMI_COMMAND"
});
