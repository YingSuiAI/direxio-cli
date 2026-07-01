import { describe, expect, it } from "vitest";
import { connectLogs, connectRestart, connectStatus, type CommandRunner } from "../src/connect.js";

function fakeRunner(result: { stdout?: string; stderr?: string; exitCode?: number } = {}): {
  runner: CommandRunner;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    runner: async (command, args) => {
      calls.push({ command, args });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0
      };
    }
  };
}

describe("connect runtime", () => {
  it("reads daemon status for a service", async () => {
    const { runner, calls } = fakeRunner({
      stdout: "direxio-connect daemon status\n\n  Status:    Running\n  WorkDir:   C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });

    await expect(connectStatus("im", { runner })).resolves.toEqual({
      service_id: "im",
      status: "Running",
      work_dir: "C:/Users/alice/.direxio/nodes/im/direxio-connect",
      raw: "direxio-connect daemon status\n\n  Status:    Running\n  WorkDir:   C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] }
    ]);
  });

  it("tails daemon logs for a service", async () => {
    const { runner, calls } = fakeRunner({ stdout: "direxio-connect is running\n" });

    await expect(connectLogs("im", { runner, lines: 40 })).resolves.toBe("direxio-connect is running\n");
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im", "-n", "40"] }
    ]);
  });

  it("restarts the service-scoped daemon", async () => {
    const { runner, calls } = fakeRunner({ stdout: "restarted\n" });

    await expect(connectRestart("im", { runner })).resolves.toEqual({
      ok: true,
      service_id: "im",
      output: "restarted\n"
    });
    expect(calls).toEqual([
      { command: "direxio-connect", args: ["daemon", "restart", "--service-name", "im"] }
    ]);
  });
});
