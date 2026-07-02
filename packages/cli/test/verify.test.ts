import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { verifyRuntime } from "../src/verify.js";

function writeRuntimeService(home: string): { serviceDir: string; context: any; stateFile: string } {
  const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
  const connectDir = join(serviceDir, "direxio-connect");
  mkdirSync(connectDir, { recursive: true });
  const credentialsFile = join(serviceDir, "credentials.json");
  const stateFile = join(serviceDir, "state.json");
  writeFileSync(
    credentialsFile,
    JSON.stringify({
      profiles: {
        default: {
          direxio_domain: "https://im.example.com",
          direxio_agent_token: "agent-secret",
          direxio_agent_room_id: "!agents:im.example.com",
          direxio_agent_node_id: "codex-im"
        }
      }
    }),
    "utf8"
  );
  writeFileSync(
    stateFile,
    JSON.stringify({
      domain: "im.example.com",
      as_url: "https://im.example.com",
      agent_token: "agent-secret",
      agent_room_id: "!agents:im.example.com",
      agent_runtime: "cursor",
      agent_service_id: "im.example.com",
      agent_service_dir: serviceDir,
      agent_credentials_file: credentialsFile,
      connect_agent: "cursor",
      connect_binary: "direxio-connect",
      connect_config: join(connectDir, "config.toml"),
      connect_install_status: "installed",
      mcp_command: "direxio-mcp"
    }),
    "utf8"
  );
  writeFileSync(join(connectDir, "config.toml"), "config = true\n", "utf8");
  return {
    serviceDir,
    stateFile,
    context: { serviceId: "im.example.com", serviceDir, credentialsFile }
  };
}

describe("runtime verification", () => {
  it("verifies connect, mcp doctor, mcp tools, and mcp smoke checks", async () => {
    await withoutAgentCommandOverrides(async () => {
      const home = mkdtempSync(join(tmpdir(), "direxio-cli-verify-"));
      const { context, stateFile } = writeRuntimeService(home);
      const calls: Array<{ command: string; args: string[] }> = [];
      const fetchCalls: Array<{ url: string; body: any }> = [];

      await expect(
        verifyRuntime(context, {
          now: () => "2026-07-01T02:03:04.000Z",
          runner: async (command, args) => {
            calls.push({ command, args });
            if (command === "direxio-mcp" && args[1] === "status") {
              return { stdout: JSON.stringify({ status: "Running" }), stderr: "", exitCode: 0 };
            }
            if (args[1] === "status") {
              return {
                stdout: `Status: Running\nWorkDir: ${dirname(join(context.serviceDir, "direxio-connect", "config.toml"))}\n`,
                stderr: "",
                exitCode: 0
              };
            }
            if (args[1] === "logs") {
              return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
            }
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          fetch: async (input, init) => {
            fetchCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
            return new Response(JSON.stringify({ room_id: "!agents:im.example.com", messages: [] }), { status: 200 });
          }
        })
      ).resolves.toMatchObject({
        status: "passed",
        failed_count: 0,
        checks: {
          connect_daemon: "passed",
          mcp_daemon: "passed",
          mcp_doctor: "passed",
          mcp_tools: "passed",
          mcp_smoke: "passed"
        }
      });

      expect(calls).toEqual([
        providerProbeCall("cursor"),
        { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im.example.com"] },
        { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im.example.com", "-n", "120"] },
        { command: "direxio-mcp", args: ["daemon", "status", "--service-name", "im.example.com", "--json"] }
      ]);
      expect(fetchCalls).toEqual([
        {
          url: "https://im.example.com/_p2p/query",
          body: { action: "mcp.messages.list", params: { room_id: "!agents:im.example.com" } }
        }
      ]);
      expect(JSON.parse(readFileSync(stateFile, "utf8")).runtime_checks.summary).toMatchObject({
        status: "passed",
        failed_count: 0,
        evidence: "all runtime checks passed"
      });
      expect(JSON.parse(readFileSync(stateFile, "utf8")).runtime_checks.agent_provider).toMatchObject({
        status: "passed",
        id: "cursor",
        label: "Cursor",
        required_binaries: ["cursor"],
        checks: ["skill", "mcp", "connect"],
        binary_checks: [{ binary: "cursor", status: "passed" }]
      });
    });
  });

  it("fails the connect daemon check when WorkDir belongs to another service", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-verify-"));
    const { context, stateFile } = writeRuntimeService(home);

    await expect(
      verifyRuntime(context, {
        now: () => "2026-07-01T02:03:04.000Z",
        runner: async (_command, args) => {
          if (args[1] === "status") {
            return { stdout: "Status: Running\nWorkDir: C:/other/service/direxio-connect\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async () => new Response(JSON.stringify({ room_id: "!agents:im.example.com", messages: [] }), { status: 200 })
      })
    ).resolves.toMatchObject({
      status: "failed",
      failed_count: 2,
      checks: {
        connect_daemon: "failed",
        mcp_daemon: "failed"
      }
    });

    expect(JSON.parse(readFileSync(stateFile, "utf8")).runtime_checks.connect_daemon).toMatchObject({
      status: "failed",
      evidence: "direxio-connect daemon belongs to a different service"
    });
  });
});

function providerProbeCall(binary: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return { command: "where.exe", args: [binary] };
  }
  return { command: "sh", args: ["-lc", `command -v '${binary}'`] };
}

async function withoutAgentCommandOverrides(run: () => Promise<void>): Promise<void> {
  const previousGeneric = process.env.DIREXIO_CONNECT_AGENT_CMD;
  const previousCursor = process.env.DIREXIO_CURSOR_COMMAND;
  delete process.env.DIREXIO_CONNECT_AGENT_CMD;
  delete process.env.DIREXIO_CURSOR_COMMAND;
  try {
    await run();
  } finally {
    restoreEnv("DIREXIO_CONNECT_AGENT_CMD", previousGeneric);
    restoreEnv("DIREXIO_CURSOR_COMMAND", previousCursor);
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
