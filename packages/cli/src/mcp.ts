import * as z from "zod/v4";
import type { ServiceConfig } from "./service-context.js";

export type JsonObject = Record<string, unknown>;
export type P2PRoute = "query" | "command";

const limitSchema = z.number().int().positive().max(100).optional();
const searchRoomsLimitSchema = z.number().int().positive().max(100).default(50);
const listContactsLimitSchema = z.number().int().positive().max(100).default(100);
const timeRangeShape = {
  from_ts: z.number().int().nonnegative().optional(),
  to_ts: z.number().int().nonnegative().optional(),
  limit: limitSchema
};

const toolSchemas = {
  list_contacts: z.object({
    query: z.string().trim().optional(),
    limit: listContactsLimitSchema
  }),
  search_rooms: z.object({
    query: z.string().trim().optional(),
    type: z.enum(["contact", "group", "channel", "all"]).optional(),
    limit: searchRoomsLimitSchema
  }),
  send_message: z.object({
    room_id: z.string().trim().min(1).optional(),
    msg: z.string().trim().min(1)
  }),
  list_messages: z.object({
    room_id: z.string().trim().min(1).optional(),
    ...timeRangeShape
  }),
  list_room_members: z.object({
    room_id: z.string().trim().min(1),
    limit: limitSchema
  }),
  list_channel_posts: z.object({
    room_id: z.string().trim().min(1),
    ...timeRangeShape
  }),
  list_post_comments: z.object({
    post_id: z.string().trim().min(1),
    ...timeRangeShape
  }),
  comment_channel_post: z.object({
    post_id: z.string().trim().min(1),
    msg: z.string().trim().min(1)
  })
} as const;

export type ToolName = keyof typeof toolSchemas;

const toolActions: Record<ToolName, { route: P2PRoute; action: string }> = {
  list_contacts: { route: "query", action: "mcp.rooms.search" },
  search_rooms: { route: "query", action: "mcp.rooms.search" },
  send_message: { route: "command", action: "mcp.messages.send" },
  list_messages: { route: "query", action: "mcp.messages.list" },
  list_room_members: { route: "query", action: "mcp.room_members.list" },
  list_channel_posts: { route: "query", action: "mcp.channel_posts.list" },
  list_post_comments: { route: "query", action: "mcp.channel_comments.list" },
  comment_channel_post: { route: "command", action: "mcp.channel_comments.create" }
};

export interface DoctorReport {
  ok: true;
  service_id: string;
  domain: string;
  agent_room_id: string | null;
  agent_node_id: string | null;
  token: "set:redacted";
  transport: "direxio-cli";
}

export function createDoctorReport(config: ServiceConfig): DoctorReport {
  return {
    ok: true,
    service_id: config.serviceId,
    domain: config.domain,
    agent_room_id: config.agentRoomId ?? null,
    agent_node_id: config.agentNodeId ?? null,
    token: "set:redacted",
    transport: "direxio-cli"
  };
}

export function listMcpTools(): ToolName[] {
  return Object.keys(toolSchemas) as ToolName[];
}

export async function callMcpTool(
  config: ServiceConfig,
  toolName: string,
  input: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<JsonObject> {
  if (!isToolName(toolName)) {
    throw new Error(`unknown MCP tool: ${toolName}`);
  }
  const params = toolSchemas[toolName].parse(input) as JsonObject;
  applyToolDefaults(toolName, params);
  applyRoomDefaults(toolName, params, config.agentRoomId);
  const { route, action } = toolActions[toolName];
  const response = await fetchImpl(`${config.domain}/_p2p/${route}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.agentToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action, params })
  });
  const text = await response.text();
  const payload = parseJsonObject(text);
  if (!response.ok) {
    const message = typeof payload.error === "string" ? payload.error : text;
    throw new Error(`${action} failed with ${response.status}: ${message}`);
  }
  return payload;
}

function isToolName(value: string): value is ToolName {
  return Object.hasOwn(toolSchemas, value);
}

function applyToolDefaults(toolName: ToolName, params: JsonObject): void {
  if (toolName === "list_contacts") {
    params.type = "contact";
  }
}

function applyRoomDefaults(toolName: ToolName, params: JsonObject, defaultAgentRoomId?: string): void {
  if (toolName === "send_message") {
    const roomId = typeof params.room_id === "string" ? params.room_id.trim() : "";
    if (!roomId) {
      throw new Error("send_message requires room_id for a non-agent room");
    }
    if (defaultAgentRoomId && roomId === defaultAgentRoomId) {
      throw new Error("send_message cannot target the service agent room");
    }
    params.room_id = roomId;
    return;
  }
  if (toolName !== "list_messages") return;
  if (typeof params.room_id === "string" && params.room_id.trim()) {
    params.room_id = params.room_id.trim();
    return;
  }
  if (!defaultAgentRoomId) {
    throw new Error("room_id is required; pass room_id or configure the service agent room");
  }
  params.room_id = defaultAgentRoomId;
}

function parseJsonObject(text: string): JsonObject {
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Direxio backend returned a non-object JSON response");
  }
  return parsed as JsonObject;
}
