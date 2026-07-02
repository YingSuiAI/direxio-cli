export type AgentId =
  | "acp"
  | "antigravity"
  | "claudecode"
  | "codex"
  | "copilot"
  | "cursor"
  | "devin"
  | "gemini"
  | "iflow"
  | "kimi"
  | "opencode"
  | "pi"
  | "qoder"
  | "reasonix"
  | "tmux";

export interface AgentProvider {
  id: AgentId;
  label: string;
  aliases: string[];
  skill: {
    pathSegments: string[];
  };
  connect: {
    agentType: string;
    requiredBinaries: string[];
    commandEnv?: string;
    defaultOptionsToml?: string;
  };
  mcp: {
    target: AgentId;
    configFiles: string[];
    supportsNativeMcp: boolean;
  };
  verify: {
    requiredBinaries: string[];
    checks: string[];
  };
}

export interface AgentProviderSummary {
  id: AgentId;
  label: string;
  aliases: string[];
  skill_path: string;
  connect_agent: string;
  command_env?: string;
  required_binaries: string[];
  mcp_config_files: string[];
  supports_native_mcp: boolean;
}
