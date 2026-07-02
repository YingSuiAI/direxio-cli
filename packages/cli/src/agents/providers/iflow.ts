import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "iflow",
  label: "iFlow",
  skillPath: [".iflow", "skills", "direxio"],
  requiredBinaries: ["iflow"],
  commandEnv: "DIREXIO_IFLOW_COMMAND"
});
