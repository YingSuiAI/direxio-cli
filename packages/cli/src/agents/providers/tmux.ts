import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "tmux",
  label: "tmux",
  skillPath: [".agent", "skills", "direxio"],
  requiredBinaries: ["tmux"],
  commandEnv: "DIREXIO_TMUX_COMMAND",
  defaultOptionsToml: 'session = "direxio"'
});
