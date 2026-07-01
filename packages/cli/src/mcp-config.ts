import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installMcpDaemon, type McpInstallReport, type McpRuntimeOptions } from "./mcp.js";
import type { ServiceConfig } from "./service-context.js";

export interface McpTargetInstallReport extends McpInstallReport {
  target: string;
  artifacts: Record<string, string>;
}

export async function installMcpTarget(
  config: ServiceConfig,
  target: string,
  options: McpRuntimeOptions = {}
): Promise<McpTargetInstallReport> {
  const daemon = await installMcpDaemon(config, options);
  const artifacts = writeMcpTargetArtifacts(config, target);
  return {
    ...daemon,
    target,
    artifacts
  };
}

function writeMcpTargetArtifacts(config: ServiceConfig, target: string): Record<string, string> {
  const normalizedTarget = target.toLowerCase();
  const targets = normalizedTarget === "all" ? ["codex", "cursor", "hermes", "json", "openclaw"] : [normalizedTarget];
  const artifacts: Record<string, string> = {};
  const mcpDir = join(config.serviceDir, "mcp");
  mkdirSync(mcpDir, { recursive: true });

  for (const item of targets) {
    if (item === "codex") artifacts.codex = writeCodexToml(config, mcpDir);
    else if (item === "cursor") artifacts.cursor = writeMcpServersJson(config, join(mcpDir, "cursor.mcp.json"));
    else if (item === "hermes") artifacts.hermes = writeMcpServersJson(config, join(mcpDir, "hermes.mcp.json"));
    else if (item === "json") artifacts.json = writeMcpServersJson(config, join(mcpDir, "mcp-servers.json"));
    else if (item === "openclaw") artifacts.openclaw = writeOpenClawServer(config, mcpDir);
    else throw new Error(`unsupported MCP target: ${target}`);
  }
  return artifacts;
}

function writeCodexToml(config: ServiceConfig, mcpDir: string): string {
  const file = join(mcpDir, "codex.toml");
  const server = tomlEscape(mcpServerName(config.serviceId));
  const service = tomlEscape(config.serviceId);
  const credentials = tomlEscape(config.credentialsFile);
  const nodeId = tomlEscape(config.agentNodeId ?? "");
  writeFileSync(
    file,
    `[mcp_servers."${server}"]\ncommand = "direxio"\nargs = ["mcp", "proxy", "--service", "${service}"]\nenv = { DIREXIO_CREDENTIALS_FILE = "${credentials}", DIREXIO_AGENT_NODE_ID = "${nodeId}" }\n`,
    "utf8"
  );
  return file;
}

function writeMcpServersJson(config: ServiceConfig, file: string): string {
  const server = mcpServerName(config.serviceId);
  writeFileSync(
    file,
    `${JSON.stringify({
      mcpServers: {
        [server]: {
          command: "direxio",
          args: ["mcp", "proxy", "--service", config.serviceId],
          env: {
            DIREXIO_CREDENTIALS_FILE: config.credentialsFile,
            DIREXIO_AGENT_NODE_ID: config.agentNodeId ?? ""
          }
        }
      }
    }, null, 2)}\n`,
    "utf8"
  );
  return file;
}

function writeOpenClawServer(config: ServiceConfig, mcpDir: string): string {
  const file = join(mcpDir, "openclaw-server.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      command: "direxio",
      args: ["mcp", "proxy", "--service", config.serviceId],
      env: {
        DIREXIO_CREDENTIALS_FILE: config.credentialsFile,
        DIREXIO_AGENT_NODE_ID: config.agentNodeId ?? ""
      }
    }, null, 2)}\n`,
    "utf8"
  );
  return file;
}

function mcpServerName(serviceId: string): string {
  const normalized = serviceId.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return `direxio-${normalized || "local"}`;
}

function tomlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
