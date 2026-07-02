import type { AgentId, AgentProvider, AgentProviderSummary } from "./types.js";

type ProviderModule = { default: AgentProvider };
type ProviderLoader = () => Promise<ProviderModule>;

const providerLoaders: Record<AgentId, ProviderLoader> = {
  acp: () => import("./providers/acp.js"),
  antigravity: () => import("./providers/antigravity.js"),
  claudecode: () => import("./providers/claudecode.js"),
  codex: () => import("./providers/codex.js"),
  copilot: () => import("./providers/copilot.js"),
  cursor: () => import("./providers/cursor.js"),
  devin: () => import("./providers/devin.js"),
  gemini: () => import("./providers/gemini.js"),
  iflow: () => import("./providers/iflow.js"),
  kimi: () => import("./providers/kimi.js"),
  opencode: () => import("./providers/opencode.js"),
  pi: () => import("./providers/pi.js"),
  qoder: () => import("./providers/qoder.js"),
  reasonix: () => import("./providers/reasonix.js"),
  tmux: () => import("./providers/tmux.js")
};

const aliasToProvider: Record<string, AgentId> = {
  claude: "claudecode",
  "claude-code": "claudecode",
  hermes: "acp",
  openclaw: "acp"
};

export const agentProviderIds = Object.freeze(Object.keys(providerLoaders) as AgentId[]);

export async function resolveAgentProvider(value: string): Promise<AgentProvider> {
  const normalized = normalizeAgentProviderName(value);
  const id = providerLoaders[normalized as AgentId] ? normalized as AgentId : aliasToProvider[normalized];
  if (!id) {
    throw new Error(`unsupported agent provider: ${value}; supported providers: ${agentProviderIds.join(", ")}`);
  }
  const provider = (await providerLoaders[id]()).default;
  return provider;
}

export async function listAgentProviders(): Promise<AgentProvider[]> {
  return await Promise.all(agentProviderIds.map(async (id) => (await providerLoaders[id]()).default));
}

export async function listAgentProviderSummaries(): Promise<AgentProviderSummary[]> {
  return (await listAgentProviders()).map((provider) => ({
    id: provider.id,
    label: provider.label,
    aliases: provider.aliases,
    skill_path: provider.skill.pathSegments.join("/"),
    connect_agent: provider.connect.agentType,
    command_env: provider.connect.commandEnv,
    required_binaries: provider.verify.requiredBinaries,
    mcp_config_files: provider.mcp.configFiles,
    supports_native_mcp: provider.mcp.supportsNativeMcp
  }));
}

function normalizeAgentProviderName(value: string): string {
  return value.trim().toLowerCase();
}
