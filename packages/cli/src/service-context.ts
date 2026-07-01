import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface ServiceContextInput {
  homeDir?: string;
  service?: string;
}

export interface ServiceContext {
  serviceId: string;
  serviceDir: string;
  credentialsFile: string;
}

export interface ServiceConfig extends ServiceContext {
  domain: string;
  agentToken: string;
  agentRoomId?: string;
  agentNodeId?: string;
}

export function resolveServiceContext(input: ServiceContextInput = {}): ServiceContext {
  const home = input.homeDir ?? homedir();
  const serviceId = input.service?.trim() || readActiveService(home);
  if (!serviceId) {
    throw new Error("service is required; pass --service <service-id> or run direxio use <service-id>");
  }
  const serviceDir = join(home, ".direxio", "nodes", serviceId);
  return {
    serviceId,
    serviceDir,
    credentialsFile: join(serviceDir, "credentials.json")
  };
}

export function loadServiceConfig(input: ServiceContextInput = {}): ServiceConfig {
  const context = resolveServiceContext(input);
  if (!existsSync(context.credentialsFile)) {
    throw new Error(`credentials file not found for service ${context.serviceId}: ${context.credentialsFile}`);
  }
  const parsed = JSON.parse(readFileSync(context.credentialsFile, "utf8")) as CredentialFile;
  const profile = parsed.profiles?.default ?? parsed;
  const domain = normalizeDomain(firstString(profile, [
    "direxio_domain",
    "as_url",
    "message_server_url",
    "homeserver",
    "domain"
  ]));
  const agentToken = firstString(profile, ["direxio_agent_token", "agent_token"]);
  if (!agentToken) {
    throw new Error(`credentials for service ${context.serviceId} are missing direxio_agent_token or agent_token`);
  }
  const agentRoomId = firstString(profile, ["direxio_agent_room_id", "agent_room_id"]) || undefined;
  const agentNodeId = firstString(profile, ["direxio_agent_node_id", "agent_node_id"]) || undefined;
  return {
    ...context,
    domain,
    agentToken,
    ...(agentRoomId ? { agentRoomId } : {}),
    ...(agentNodeId ? { agentNodeId } : {})
  };
}

export function writeActiveService(serviceId: string, homeDir: string = homedir()): string {
  const activeFile = activeServiceFile(homeDir);
  mkdirSync(dirname(activeFile), { recursive: true });
  writeFileSync(activeFile, `${serviceId.trim()}\n`, "utf8");
  return activeFile;
}

export function activeServiceFile(homeDir: string = homedir()): string {
  return join(homeDir, ".direxio", "active-service");
}

function readActiveService(homeDir: string): string {
  const file = activeServiceFile(homeDir);
  if (!existsSync(file)) return "";
  return readFileSync(file, "utf8").trim();
}

function normalizeDomain(value: string): string {
  if (!value) {
    throw new Error("credentials are missing direxio_domain, homeserver, or domain");
  }
  const parsed = new URL(value);
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

type CredentialFile = {
  profiles?: {
    default?: Record<string, unknown>;
  };
} & Record<string, unknown>;
