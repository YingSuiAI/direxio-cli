import type { AgentId, AgentProvider } from "../types.js";

export function defineProvider(input: {
  id: AgentId;
  label: string;
  aliases?: string[];
  skillPath: string[];
  agentType?: string;
  requiredBinaries?: string[];
  commandEnv?: string;
  defaultOptionsToml?: string;
  mcpConfigFiles?: string[];
  supportsNativeMcp?: boolean;
}): AgentProvider {
  const requiredBinaries = input.requiredBinaries ?? [input.id];
  return {
    id: input.id,
    label: input.label,
    aliases: input.aliases ?? [],
    skill: {
      pathSegments: input.skillPath
    },
    connect: {
      agentType: input.agentType ?? input.id,
      requiredBinaries,
      ...(input.commandEnv ? { commandEnv: input.commandEnv } : {}),
      ...(input.defaultOptionsToml ? { defaultOptionsToml: input.defaultOptionsToml } : {})
    },
    mcp: {
      target: input.id,
      configFiles: input.mcpConfigFiles ?? [`${input.id}.mcp.json`],
      supportsNativeMcp: input.supportsNativeMcp ?? true
    },
    verify: {
      requiredBinaries,
      checks: ["skill", "mcp", "connect"]
    }
  };
}
