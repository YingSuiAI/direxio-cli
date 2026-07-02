import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "pi",
  label: "Pi Agent",
  skillPath: [".pi", "agent", "skills", "direxio"],
  requiredBinaries: ["pi"],
  commandEnv: "DIREXIO_PI_COMMAND"
});
