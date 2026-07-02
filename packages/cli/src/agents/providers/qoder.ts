import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "qoder",
  label: "Qoder",
  skillPath: [".qoder", "skills", "direxio"],
  requiredBinaries: ["qoder"],
  commandEnv: "DIREXIO_QODER_COMMAND"
});
