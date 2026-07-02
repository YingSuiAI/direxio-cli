import { defineProvider } from "./_define.js";

export default defineProvider({
  id: "reasonix",
  label: "Reasonix",
  skillPath: [".reasonix", "skills", "direxio"],
  requiredBinaries: ["reasonix"],
  commandEnv: "DIREXIO_REASONIX_COMMAND",
  defaultOptionsToml: 'serve_url = "http://127.0.0.1:8719"'
});
