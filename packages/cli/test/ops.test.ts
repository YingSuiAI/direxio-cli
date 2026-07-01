import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resetAppData, updateService } from "../src/ops.js";

function writeOpsState(home: string): { context: any; stateFile: string; serviceDir: string } {
  const serviceDir = join(home, ".direxio", "nodes", "ops.example.test");
  mkdirSync(join(serviceDir, "direxio-connect"), { recursive: true });
  const stateFile = join(serviceDir, "state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({
      domain: "ops.example.test",
      as_url: "https://ops.example.test",
      password: "12345678",
      access_token: "ACCESS_SECRET",
      agent_token: "AGENT_SECRET",
      agent_room_id: "!old:ops.example.test",
      agent_service_id: "ops.example.test",
      agent_service_dir: serviceDir,
      agent_credentials_file: join(serviceDir, "credentials.json"),
      connect_install_status: "installed",
      connect_config: join(serviceDir, "direxio-connect", "config.toml"),
      connect_binary: "direxio-connect",
      mcp_install_status: "installed",
      mcp_daemon_install_status: "installed",
      resources: {
        public_ip: "203.0.113.77",
        key_file: join(serviceDir, "ssh.pem")
      },
      phases: {
        S5_INIT_TOKENS: { status: "done" },
        S6_WIRE_LOCAL: { status: "done" },
        S7_VERIFY_E2E: { status: "done" }
      },
      user_confirmations: {
        app_initialization: { status: "confirmed", evidence: "old app confirmation" },
        real_chat: { status: "confirmed", evidence: "old chat confirmation" },
        agent_mcp_runtime: { status: "confirmed", evidence: "old runtime confirmation" }
      },
      runtime_checks: {
        summary: { status: "passed" }
      }
    }),
    "utf8"
  );
  writeFileSync(join(serviceDir, "direxio-connect", "config.toml"), "config = true\n", "utf8");
  return {
    serviceDir,
    stateFile,
    context: { serviceId: "ops.example.test", serviceDir, credentialsFile: join(serviceDir, "credentials.json") }
  };
}

describe("existing node operations", () => {
  it("updates the remote service without clearing local confirmations", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-ops-"));
    const { context, stateFile, serviceDir } = writeOpsState(home);
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      updateService(context, {
        messageServerImage: "direxio/message-server:test",
        now: () => "2026-07-01T03:04:05.000Z",
        runner: async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).resolves.toEqual({
      ok: true,
      operation: "update",
      report: join(serviceDir, "operation-report.json")
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("ssh");
    expect(calls[0].args.join(" ")).toContain("docker compose --env-file .env pull");
    expect(calls[0].args.join(" ")).toContain("MESSAGE_SERVER_IMAGE");
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      password: "12345678",
      connect_install_status: "installed",
      user_confirmations: {
        agent_mcp_runtime: { status: "confirmed" }
      },
      runtime_checks: {
        summary: { status: "passed" }
      }
    });
    expect(JSON.parse(readFileSync(join(serviceDir, "operation-report.json"), "utf8"))).toMatchObject({
      operation_type: "update",
      status: "update_remote_restart_complete",
      security: { secrets_included: false }
    });
  });

  it("resets app data only after confirmation and marks local wiring refresh pending", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-ops-"));
    const { context, stateFile, serviceDir } = writeOpsState(home);
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(resetAppData(context, { confirm: false })).rejects.toThrow("requires confirm=true");

    await expect(
      resetAppData(context, {
        confirm: true,
        now: () => "2026-07-01T03:04:05.000Z",
        runner: async (command, args) => {
          calls.push({ command, args });
          if (command === "direxio-connect" && args[1] === "status") {
            return { stdout: `Status: Running\nWorkDir: ${join(serviceDir, "direxio-connect")}\n`, stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).resolves.toEqual({
      ok: true,
      operation: "reset_app_data",
      report: join(serviceDir, "operation-report.json")
    });

    expect(calls[0].command).toBe("ssh");
    expect(calls[0].args[0]).toBe("-i");
    expect(calls.slice(1).map((call) => `${call.command} ${call.args.slice(0, 2).join(" ")}`)).toEqual([
      "direxio-connect daemon status",
      "direxio-connect daemon stop"
    ]);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(state).not.toHaveProperty("password");
    expect(state).not.toHaveProperty("access_token");
    expect(state).not.toHaveProperty("agent_token");
    expect(state).not.toHaveProperty("agent_room_id");
    expect(state).not.toHaveProperty("user_confirmations");
    expect(state).not.toHaveProperty("runtime_checks");
    expect(state).toMatchObject({
      connect_install_status: "refresh_pending",
      mcp_install_status: "refresh_pending",
      mcp_daemon_install_status: "refresh_pending",
      phases: {
        S5_INIT_TOKENS: { status: "pending" },
        S6_WIRE_LOCAL: { status: "pending" },
        S7_VERIFY_E2E: { status: "pending" }
      }
    });
  });
});
