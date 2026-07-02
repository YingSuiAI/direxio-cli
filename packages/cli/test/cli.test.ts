import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/index.js";

function writeServiceCredentials(home: string, serviceId: string): void {
  const serviceDir = join(home, ".direxio", "nodes", serviceId);
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(
    join(serviceDir, "credentials.json"),
    JSON.stringify({
      profiles: {
        default: {
          direxio_domain: `https://${serviceId}`,
          direxio_agent_token: "agent-secret",
          direxio_agent_room_id: `!agents:${serviceId}`,
          direxio_agent_node_id: "codex-im"
        }
      }
    })
  );
}

describe("direxio CLI", () => {
  it("prints JSON mcp doctor reports", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "credentials.json"),
      JSON.stringify({
        profiles: {
          default: {
            direxio_domain: "https://im.example.com",
            direxio_agent_token: "agent-secret",
            direxio_agent_room_id: "!agents:im.example.com"
          }
        }
      })
    );
    const stdout: string[] = [];

    const code = await runCli(["mcp", "doctor", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      service_id: "im.example.com",
      domain: "https://im.example.com",
      token: "set:redacted"
    });
    expect(stdout.join("\n")).not.toContain("agent-secret");
  });

  it("prints AWS onboarding guidance", async () => {
    const stdout: string[] = [];

    const code = await runCli(["onboard", "aws", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      paths: expect.arrayContaining([
        expect.objectContaining({ id: "root-access-key" }),
        expect.objectContaining({ id: "dedicated-iam-user" })
      ])
    });
  });

  it("lists supported agent provider plugins", async () => {
    const stdout: string[] = [];

    const code = await runCli(["agents", "list", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      agents: expect.arrayContaining([
        expect.objectContaining({
          id: "codex",
          connect_agent: "codex",
          skill_path: ".codex/skills/direxio",
          mcp_config_files: ["codex.toml"]
        }),
        expect.objectContaining({
          id: "cursor",
          required_binaries: ["cursor"]
        }),
        expect.objectContaining({
          id: "gemini",
          command_env: "DIREXIO_GEMINI_COMMAND"
        })
      ])
    });
  });

  it("checks selected agent provider dependencies", async () => {
    await withoutAgentCommandOverrides(async () => {
      const stdout: string[] = [];
      const commands: Array<{ command: string; args: string[] }> = [];

      const code = await runCli(["agents", "check", "--agent", "cursor", "--json"], {
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        runner: async (command, args) => {
          commands.push({ command, args });
          return { stdout: "cursor\n", stderr: "", exitCode: 0 };
        }
      });

      expect(code).toBe(0);
      expect(commands).toEqual([providerProbeCall("cursor")]);
      expect(JSON.parse(stdout.join("\n"))).toMatchObject({
        status: "passed",
        id: "cursor",
        binary_checks: [
          {
            binary: "cursor",
            status: "passed"
          }
        ]
      });
    });
  });

  it("routes AWS CSV import through the public CLI", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-aws-"));
    const csv = join(home, "keys.csv");
    writeFileSync(csv, "Access key ID,Secret access key\nAKIACLI,SECRETCLI\n", "utf8");
    const stdout: string[] = [];

    const code = await runCli(["aws", "import-csv", "--profile", "direxio-deployer", "--region", "us-west-2", csv, "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async () => ({
        stdout: JSON.stringify({
          Account: "123456789012",
          Arn: "arn:aws:iam::123456789012:user/DirexioDeployer"
        }),
        stderr: "",
        exitCode: 0
      })
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      profile: "direxio-deployer",
      arn: "arn:aws:iam::<account>:user/DirexioDeployer"
    });
    expect(stdout.join("\n")).not.toContain("SECRETCLI");
  });

  it("routes connect status through the service-scoped daemon command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["connect", "status", "--service", "im", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: "Status: Running\nWorkDir: C:/Users/alice/.direxio/nodes/im/direxio-connect\n",
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      service_id: "im",
      status: "Running",
      work_dir: "C:/Users/alice/.direxio/nodes/im/direxio-connect",
      raw: "Status: Running\nWorkDir: C:/Users/alice/.direxio/nodes/im/direxio-connect\n"
    });
  });

  it("routes connect install through npm, daemon install, and readiness checks", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im");
    const configFile = join(serviceDir, "direxio-connect", "config.toml");
    mkdirSync(join(serviceDir, "direxio-connect"), { recursive: true });
    writeFileSync(configFile, "config = true\n");
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["connect", "install", "--service", "im", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        if (command === "direxio-connect" && args[1] === "status") {
          return { stdout: "Status: Running\n", stderr: "", exitCode: 0 };
        }
        if (command === "direxio-connect" && args[1] === "logs") {
          return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "npm", args: ["install", "-g", "direxio-connent@latest"] },
      {
        command: "direxio-connect",
        args: ["daemon", "install", "--config", configFile, "--service-name", "im", "--force"]
      },
      { command: "direxio-connect", args: ["daemon", "status", "--service-name", "im"] },
      { command: "direxio-connect", args: ["daemon", "logs", "--service-name", "im", "-n", "120"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      ok: true,
      service_id: "im",
      package: "direxio-connent@latest",
      config: configFile,
      readiness: "direxio-connect is running"
    });
  });

  it("routes mcp status through the service-scoped daemon command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "status", "--service", "im", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return {
          stdout: JSON.stringify({ service_name: "direxio-mcp-im", status: "Stopped", url: "" }),
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-mcp", args: ["daemon", "status", "--service-name", "im", "--json"] }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      service_name: "direxio-mcp-im",
      status: "Stopped",
      url: ""
    });
  });

  it("routes mcp install through npm and daemon install", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    writeServiceCredentials(home, "im.example.com");
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "install", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "npm", args: ["install", "-g", "direxio-mcp@latest"] },
      {
        command: "direxio-mcp",
        args: [
          "daemon",
          "install",
          "--service-name",
          "im.example.com",
          "--credentials-file",
          join(home, ".direxio", "nodes", "im.example.com", "credentials.json"),
          "--node-id",
          "codex-im",
          "--host",
          "127.0.0.1",
          "--port",
          "19757"
        ]
      }
    ]);
    expect(JSON.parse(stdout.join("\n"))).toEqual({
      ok: true,
      service_id: "im.example.com",
      package: "direxio-mcp@latest",
      daemon_url: "http://127.0.0.1:19757/mcp"
    });
  });

  it("routes mcp proxy through the stdio proxy command", async () => {
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "proxy"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "proxy exited\n", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands).toEqual([
      { command: "direxio-mcp", args: ["proxy", "--url", "http://127.0.0.1:19757/mcp"] }
    ]);
    expect(stdout.join("\n")).toBe("proxy exited\n");
  });

  it("generates mcp target snippets during mcp install", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    writeServiceCredentials(home, "im.example.com");
    const stdout: string[] = [];
    const commands: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(["mcp", "install", "--service", "im.example.com", "--target", "codex", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        commands.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(commands[0]).toEqual({ command: "npm", args: ["install", "-g", "direxio-mcp@latest"] });
    const codexToml = readFileSync(join(home, ".direxio", "nodes", "im.example.com", "mcp", "codex.toml"), "utf8");
    expect(codexToml).toContain('command = "direxio"');
    expect(codexToml).toContain('args = ["mcp", "proxy", "--service", "im.example.com"]');
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      service_id: "im.example.com",
      target: "codex"
    });
  });

  it("prints redacted service status from state", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        domain: "im.example.com",
        password: "12345678",
        access_token: "ACCESS_SECRET",
        agent_token: "AGENT_SECRET",
        phases: { S7_VERIFY_E2E: { status: "done" } },
        runtime_checks: { summary: { status: "passed" } }
      }),
      "utf8"
    );
    const stdout: string[] = [];

    const code = await runCli(["status", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).not.toContain("12345678");
    expect(output).not.toContain("ACCESS_SECRET");
    expect(output).not.toContain("AGENT_SECRET");
    expect(JSON.parse(output)).toMatchObject({
      operation_type: "status",
      status: "status_report",
      domain: "im.example.com",
      security: { secrets_included: false }
    });
  });

  it("confirms user gates with explicit evidence", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(join(serviceDir, "state.json"), JSON.stringify({ domain: "im.example.com" }), "utf8");
    const stdout: string[] = [];

    const code = await runCli(
      [
        "confirm",
        "app-initialization",
        "--service",
        "im.example.com",
        "--evidence",
        "user finished app initialization with the current code",
        "--json"
      ],
      {
        homeDir: home,
        stdout: (line) => stdout.push(line),
        stderr: () => {}
      }
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      gate: "app_initialization",
      status: "confirmed"
    });
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      user_confirmations: {
        app_initialization: {
          status: "confirmed",
          evidence: "user finished app initialization with the current code"
        }
      }
    });
  });

  it("routes verify runtime through runtime verification checks", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "im.example.com");
    const connectDir = join(serviceDir, "direxio-connect");
    mkdirSync(connectDir, { recursive: true });
    const credentialsFile = join(serviceDir, "credentials.json");
    writeFileSync(
      credentialsFile,
      JSON.stringify({
        profiles: {
          default: {
            direxio_domain: "https://im.example.com",
            direxio_agent_token: "agent-secret",
            direxio_agent_room_id: "!agents:im.example.com"
          }
        }
      }),
      "utf8"
    );
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        domain: "im.example.com",
        agent_service_id: "im.example.com",
        agent_service_dir: serviceDir,
        agent_credentials_file: credentialsFile,
        connect_config: join(connectDir, "config.toml"),
        connect_install_status: "installed"
      }),
      "utf8"
    );
    writeFileSync(join(connectDir, "config.toml"), "config = true\n", "utf8");
    const stdout: string[] = [];

    const code = await runCli(["verify", "runtime", "--service", "im.example.com", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        if (command === "direxio-mcp" && args[1] === "status") {
          return { stdout: JSON.stringify({ status: "Running" }), stderr: "", exitCode: 0 };
        }
        if (args[1] === "status") {
          return { stdout: `Status: Running\nWorkDir: ${dirname(join(connectDir, "config.toml"))}\n`, stderr: "", exitCode: 0 };
        }
        if (args[1] === "logs") {
          return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async () => new Response(JSON.stringify({ room_id: "!agents:im.example.com", messages: [] }), { status: 200 })
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      status: "passed",
      failed_count: 0
    });
  });

  it("routes update and reset app data operations", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "ops.example.test");
    const connectDir = join(serviceDir, "direxio-connect");
    mkdirSync(connectDir, { recursive: true });
    const state = {
      domain: "ops.example.test",
      agent_service_id: "ops.example.test",
      agent_service_dir: serviceDir,
      connect_config: join(connectDir, "config.toml"),
      connect_binary: "direxio-connect",
      resources: { public_ip: "203.0.113.77", key_file: join(serviceDir, "ssh.pem") }
    };
    writeFileSync(join(serviceDir, "state.json"), JSON.stringify(state), "utf8");
    writeFileSync(join(connectDir, "config.toml"), "config = true\n", "utf8");
    const stdout: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    const updateCode = await runCli(["update", "--service", "ops.example.test", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(updateCode).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "{}")).toMatchObject({ ok: true, operation: "update" });

    const resetCode = await runCli(["reset-app-data", "--service", "ops.example.test", "--confirm", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        calls.push({ command, args });
        if (command === "direxio-connect" && args[1] === "status") {
          return { stdout: `Status: Running\nWorkDir: ${connectDir}\n`, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(resetCode).toBe(0);
    expect(JSON.parse(stdout.pop() ?? "{}")).toMatchObject({ ok: true, operation: "reset_app_data" });
    expect(calls.some((call) => call.command === "ssh")).toBe(true);
    expect(calls.some((call) => call.command === "direxio-connect" && call.args[1] === "stop")).toBe(true);
  });

  it("routes destroy through the destroy operation", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const serviceDir = join(home, ".direxio", "nodes", "destroy.example.test");
    const connectDir = join(serviceDir, "direxio-connect");
    mkdirSync(connectDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        domain: "destroy.example.test",
        agent_service_id: "destroy.example.test",
        agent_service_dir: serviceDir,
        connect_config: join(connectDir, "config.toml"),
        resources: { instance_id: "i-destroy" }
      }),
      "utf8"
    );
    writeFileSync(join(connectDir, "config.toml"), "config = true\n", "utf8");
    const stdout: string[] = [];

    const code = await runCli(["destroy", "--service", "destroy.example.test", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {},
      runner: async (command, args) => {
        if (command === "direxio-connect" && args[1] === "status") {
          return { stdout: `Status: Running\nWorkDir: ${connectDir}\n`, stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      operation: "destroy"
    });
  });

  it("routes skill install for an agent", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const stdout: string[] = [];

    const code = await runCli(["skill", "install", "--agent", "codex", "--json"], {
      homeDir: home,
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      action: "install",
      agent: "codex",
      path: join(home, ".codex", "skills", "direxio")
    });
    expect(readFileSync(join(home, ".codex", "skills", "direxio", "SKILL.md"), "utf8")).toContain("direxio mcp");
  });

  it("prints skill-specific help for agent bootstrap", async () => {
    const stdout: string[] = [];

    const code = await runCli(["skill", "--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("direxio skill install --agent <provider>");
    expect(output).toContain("direxio agents list --json");
    expect(output).toContain("server operations");
    expect(output).toContain("MCP smoke");
    expect(output).toContain("npx -y @direxio/cli@latest skill install --agent codex --json");
    expect(output).toContain("direxio --help");
  });

  it("prints top-level help with deploy confirmation guidance", async () => {
    const stdout: string[] = [];

    const code = await runCli(["--help"], {
      stdout: (line) => stdout.push(line),
      stderr: () => {}
    });

    expect(code).toBe(0);
    const output = stdout.join("\n");
    expect(output).toContain("direxio deploy --service <id>");
    expect(output).toContain("direxio skill --help");
    expect(output).toContain("confirmation checklist");
    expect(output).toContain("confirm_command");
    expect(output).toContain("direxio <command> --help");
  });

  it("prints command-specific operational help", async () => {
    const deployStdout: string[] = [];
    const mcpStdout: string[] = [];
    const updateStdout: string[] = [];

    await expect(runCli(["deploy", "--help"], {
      stdout: (line) => deployStdout.push(line),
      stderr: () => {}
    })).resolves.toBe(0);
    await expect(runCli(["mcp", "--help"], {
      stdout: (line) => mcpStdout.push(line),
      stderr: () => {}
    })).resolves.toBe(0);
    await expect(runCli(["update", "--help"], {
      stdout: (line) => updateStdout.push(line),
      stderr: () => {}
    })).resolves.toBe(0);

    expect(deployStdout.join("\n")).toContain("confirmation checklist");
    expect(deployStdout.join("\n")).toContain("selected_cloud");
    expect(deployStdout.join("\n")).toContain("confirm_command");
    expect(mcpStdout.join("\n")).toContain("search_rooms");
    expect(mcpStdout.join("\n")).toContain("Do not test every MCP tool");
    expect(updateStdout.join("\n")).toContain("--image direxio/message-server:<tag>");
    expect(updateStdout.join("\n")).toContain("without recreating Lightsail/EC2");
  });

  it("prints a deploy confirmation checklist before creating cloud resources", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-plan-"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(
      [
        "deploy",
        "--service",
        "plan.example.test",
        "--domain",
        "plan.example.test",
        "--region",
        "us-east-1",
        "--confirm-domain",
        "--json"
      ],
      {
        homeDir: home,
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" && args[0] === "--region" ? args.slice(2) : args;
          if (command === "aws" && awsArgs[0] === "freetier") {
            return {
              stdout: JSON.stringify({
                freeTierUsages: [
                  {
                    service: "Amazon Lightsail",
                    actualUsageAmount: 25,
                    limit: 750,
                    unit: "Hrs"
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-regions") {
            return {
              stdout: JSON.stringify({
                regions: [
                  {
                    name: "us-east-1",
                    availabilityZones: [{ zoneName: "us-east-1a", state: "available" }]
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-bundles") {
            return {
              stdout: JSON.stringify({
                bundles: [
                  {
                    bundleId: "medium_3_0",
                    price: 12,
                    ramSizeInGb: 2,
                    diskSizeInGb: 60,
                    supportedPlatforms: ["LINUX_UNIX"]
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          return { stdout: "{}", stderr: "", exitCode: 0 };
        }
      }
    );

    expect(code).toBe(2);
    expect(stderr).toEqual([]);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan).toMatchObject({
      ok: false,
      operation: "deploy",
      status: "confirmation_required",
      service_id: "plan.example.test",
      domain: "plan.example.test",
      region: "us-east-1",
      selected_cloud: "lightsail",
      selected_cloud_source: "default",
      recommended_cloud: "lightsail",
      choices: {
        cloud: ["lightsail", "ec2"],
        dns: ["auto", "route53", "user"],
        agent_install: ["auto", "recommend", "skip"]
      },
      aws_free_tier: {
        status: "queried"
      }
    });
    expect(plan.checklist).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "cloud", selected: "lightsail", choices: ["lightsail", "ec2"] }),
      expect.objectContaining({ id: "lightsail_bundle", selected: "$12/month Linux/Unix bundle" }),
      expect.objectContaining({ id: "lightsail_availability_zone", selected: "us-east-1a" }),
      expect.objectContaining({ id: "dns", selected: "auto" }),
      expect.objectContaining({ id: "local_install", selected: "auto" })
    ]));
    expect(plan.confirm_command).toContain("--confirm-deploy");
    expect(calls.some((call) => call.command === "aws" && call.args.includes("create-instances"))).toBe(false);
    expect(calls.some((call) => call.command === "aws" && call.args.includes("run-instances"))).toBe(false);
  });

  it("selects EC2 in the deploy confirmation checklist when Lightsail has no available zone", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-plan-ec2-"));
    const stdout: string[] = [];
    const calls: Array<{ command: string; args: string[] }> = [];

    const code = await runCli(
      [
        "deploy",
        "--service",
        "plan-ec2.example.test",
        "--domain",
        "plan-ec2.example.test",
        "--region",
        "us-east-1",
        "--confirm-domain",
        "--json"
      ],
      {
        homeDir: home,
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" && args[0] === "--region" ? args.slice(2) : args;
          if (command === "aws" && awsArgs[0] === "freetier") return { stdout: JSON.stringify({ freeTierUsages: [] }), stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-bundles") {
            return {
              stdout: JSON.stringify({
                bundles: [{ bundleId: "medium_3_0", price: 12, ramSizeInGb: 2, diskSizeInGb: 60, supportedPlatforms: ["LINUX_UNIX"] }]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-regions") {
            return {
              stdout: JSON.stringify({
                regions: [
                  {
                    name: "us-east-1",
                    availabilityZones: [
                      { zoneName: "us-east-1a", state: "unavailable" },
                      { zoneName: "us-east-1b", state: "unavailable" }
                    ]
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          return { stdout: "{}", stderr: "", exitCode: 0 };
        }
      }
    );

    expect(code).toBe(2);
    const plan = JSON.parse(stdout.join("\n"));
    expect(plan).toMatchObject({
      status: "confirmation_required",
      selected_cloud: "ec2",
      selected_cloud_source: "availability",
      recommended_cloud: "ec2",
      availability: {
        lightsail: {
          status: "unavailable",
          availability_zone: {
            status: "unavailable",
            default_zone: "us-east-1a",
            available_zones: []
          }
        }
      }
    });
    expect(plan.confirm_command).toContain("--cloud ec2");
    expect(calls.some((call) => call.command === "aws" && call.args.includes("create-instances"))).toBe(false);
    expect(calls.some((call) => call.command === "aws" && call.args.includes("run-instances"))).toBe(false);
  });

  it("routes deploy through the deployment state machine", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-"));
    const stdout: string[] = [];

    const code = await runCli(
      [
        "deploy",
        "--service",
        "deploy.example.test",
        "--domain",
        "deploy.example.test",
        "--cloud",
        "ec2",
        "--region",
        "ap-northeast-1",
        "--confirm-domain",
        "--confirm-deploy",
        "--json"
      ],
      {
        homeDir: home,
        stdout: (line) => stdout.push(line),
        stderr: () => {},
        runner: async (command, args) => {
          const awsArgs = command === "aws" && args[0] === "--region" ? args.slice(2) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-cli"}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-cli"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-cli","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: '{"Instances":[{"InstanceId":"i-cli","BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-cli"}}]}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "allocate-address") return { stdout: '{"AllocationId":"eipalloc-cli","PublicIp":"203.0.113.43"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-hosted-zone") return { stdout: '{"HostedZone":{"Id":"/hostedzone/ZCLI"}}', stderr: "", exitCode: 0 };
          if (command === "ssh") return { stdout: '{"password":"12345678","access_token":"owner","agent_token":"agent","agent_room_id":"!agents:deploy.example.test"}', stderr: "", exitCode: 0 };
          if (command === "direxio-connect" && args[1] === "status") return { stdout: `Status: Running\nWorkDir: ${join(home, ".direxio", "nodes", "deploy.example.test", "direxio-connect")}\n`, stderr: "", exitCode: 0 };
          if (command === "direxio-connect" && args[1] === "logs") return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
          if (command === "direxio-mcp" && args[1] === "status") return { stdout: '{"status":"Running"}', stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async (input) => {
          if (String(input) === "https://deploy.example.test/_p2p/query") {
            return new Response(JSON.stringify({ room_id: "!agents:deploy.example.test", messages: [] }), { status: 200 });
          }
          if (String(input) === "https://deploy.example.test/healthz") {
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          return new Response(JSON.stringify({
            access_token: "matrix",
            device_id: "DEV",
            user_id: "@agent:deploy.example.test",
            homeserver: "https://deploy.example.test"
          }), { status: 200 });
        },
        dnsResolver: {
          resolve4: async () => ["203.0.113.43"]
        }
      }
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      ok: true,
      service_id: "deploy.example.test",
      domain: "deploy.example.test"
    });
  });

  it("returns exit code 2 when deploy is waiting for user-managed DNS", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-command-wait-dns-"));
    const stderr: string[] = [];

    const code = await runCli(
      [
        "deploy",
        "--service",
        "wait-dns.example.test",
        "--domain",
        "wait-dns.example.test",
        "--cloud",
        "ec2",
        "--region",
        "us-east-1",
        "--dns",
        "user",
        "--confirm-domain",
        "--confirm-deploy",
        "--json"
      ],
      {
        homeDir: home,
        stdout: () => {},
        stderr: (line) => stderr.push(line),
        runner: async (command, args) => {
          const awsArgs = command === "aws" && args[0] === "--region" ? args.slice(2) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-wait-dns"}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-wait-dns"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-wait-dns","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: '{"Instances":[{"InstanceId":"i-wait-dns","BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-wait-dns"}}]}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "allocate-address") return { stdout: '{"AllocationId":"eipalloc-wait-dns","PublicIp":"203.0.113.91"}', stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        dnsResolver: {
          resolve4: async () => []
        }
      }
    );

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain("waiting for DNS A record wait-dns.example.test -> 203.0.113.91");
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
