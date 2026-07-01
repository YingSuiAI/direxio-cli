import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deployService } from "../src/deploy.js";

describe("deploy operation", () => {
  it("runs the deployment state machine and writes credentials, connect config, mcp snippets, state, and report", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const fetchCalls: Array<{ url: string; body: any; authorization: string | null }> = [];
    const healthCalls: string[] = [];

    await expect(
      deployService({
        homeDir: home,
        serviceId: "deploy.example.test",
        domain: "deploy.example.test",
        region: "ap-northeast-1",
        agent: "codex",
        mcpTarget: "codex",
        workspace: join(home, "workspace"),
        confirmDomainBinding: true,
        now: () => "2026-07-02T01:02:03.000Z",
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") {
            return { stdout: JSON.stringify({ Account: "123456789012", Arn: "arn:aws:iam::123456789012:user/test" }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[0] === "ssm") {
            return { stdout: JSON.stringify({ Parameters: [{ Value: "ami-ubuntu-real" }] }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[1] === "create-security-group") {
            return { stdout: JSON.stringify({ GroupId: "sg-deploy" }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[1] === "create-key-pair") {
            return { stdout: JSON.stringify({ KeyName: "direxio-deploy", KeyMaterial: "PRIVATE_KEY" }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[1] === "run-instances") {
            return {
              stdout: JSON.stringify({
                Instances: [
                  {
                    InstanceId: "i-deploy",
                    BlockDeviceMappings: [{ Ebs: { VolumeId: "vol-deploy-root" } }]
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "aws" && awsArgs[1] === "allocate-address") {
            return { stdout: JSON.stringify({ AllocationId: "eipalloc-deploy", PublicIp: "203.0.113.42" }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-hosted-zones") {
            return { stdout: JSON.stringify({ HostedZones: [{ Id: "/hostedzone/ZPARENT", Name: "example.test." }] }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "create-hosted-zone") {
            return { stdout: JSON.stringify({ HostedZone: { Id: "/hostedzone/ZDEPLOY" } }), stderr: "", exitCode: 0 };
          }
          if (command === "ssh") {
            return {
              stdout: JSON.stringify({
                password: "12345678",
                access_token: "owner-secret",
                agent_token: "agent-secret",
                agent_room_id: "!agents:deploy.example.test"
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "direxio-connect" && args[1] === "status") {
            return { stdout: `Status: Running\nWorkDir: ${join(home, ".direxio", "nodes", "deploy.example.test", "direxio-connect")}\n`, stderr: "", exitCode: 0 };
          }
          if (command === "direxio-connect" && args[1] === "logs") {
            return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async (input, init) => {
          const url = String(input);
          if (url === "https://deploy.example.test/healthz") {
            healthCalls.push(url);
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          fetchCalls.push({
            url,
            authorization: new Headers(init?.headers).get("authorization"),
            body: JSON.parse(String(init?.body))
          });
          return new Response(JSON.stringify({
            access_token: "matrix-agent-token",
            device_id: "DEVDEPLOY",
            user_id: "@agent:deploy.example.test",
            homeserver: "https://deploy.example.test"
          }), { status: 200 });
        }
      })
    ).resolves.toMatchObject({
      ok: true,
      service_id: "deploy.example.test",
      domain: "deploy.example.test",
      report: join(home, ".direxio", "nodes", "deploy.example.test", "operation-report.json")
    });

    const serviceDir = join(home, ".direxio", "nodes", "deploy.example.test");
    const state = JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "S7_VERIFY_E2E",
      domain_mode: "route53",
      domain: "deploy.example.test",
      region: "ap-northeast-1",
      agent_room_id: "!agents:deploy.example.test",
      connect_install_status: "installed",
      mcp_install_status: "installed",
      mcp_daemon_install_status: "installed",
      resources: {
        instance_id: "i-deploy",
        root_volume_id: "vol-deploy-root",
        eip_id: "eipalloc-deploy",
        public_ip: "203.0.113.42",
        sg_id: "sg-deploy",
        route53_zone_id: "ZPARENT",
        route53_zone_created_by_deployer: "false"
      }
    });
    expect(state.billing_warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("Elastic IP"),
      expect.stringContaining("Route53")
    ]));
    expect(JSON.stringify(JSON.parse(readFileSync(join(serviceDir, "operation-report.json"), "utf8")))).not.toContain("agent-secret");
    expect(JSON.parse(readFileSync(join(serviceDir, "credentials.json"), "utf8"))).toMatchObject({
      profiles: {
        default: {
          direxio_domain: "https://deploy.example.test",
          direxio_agent_token: "agent-secret",
          direxio_agent_room_id: "!agents:deploy.example.test"
        }
      }
    });
    const connectConfig = readFileSync(join(serviceDir, "direxio-connect", "config.toml"), "utf8");
    expect(connectConfig).toContain('access_token = "matrix-agent-token"');
    expect(connectConfig).toContain('room_id = "!agents:deploy.example.test"');
    expect(existsSync(join(serviceDir, "mcp", "codex.toml"))).toBe(true);
    expect(fetchCalls).toEqual([
      {
        url: "https://deploy.example.test/_p2p/command",
        authorization: "Bearer agent-secret",
        body: { action: "agent.matrix_session.create", params: { device_id: "direxio-connect-deploy.example.test" } }
      }
    ]);
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "ec2" && normalizedAwsArgs(call.args)[1] === "run-instances")).toBe(true);
    for (const call of calls.filter((item) => item.command === "aws")) {
      expect(call.args.slice(0, 2)).toEqual(["--region", "ap-northeast-1"]);
    }
    const createSecurityGroup = calls.find((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "ec2" && normalizedAwsArgs(call.args)[1] === "create-security-group");
    const description = createSecurityGroup?.args[(createSecurityGroup?.args.indexOf("--description") ?? -1) + 1] ?? "";
    expect(description).toMatch(/^Direxio-/);
    expect(description).not.toMatch(/\s/);
    const runInstances = calls.find((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "ec2" && normalizedAwsArgs(call.args)[1] === "run-instances");
    expect(runInstances?.args).toContain("ami-ubuntu-real");
    expect(runInstances?.args).toContain("--count");
    expect(runInstances?.args).toContain("1");
    expect(runInstances?.args).not.toContain("--min-count");
    expect(runInstances?.args).not.toContain("--max-count");
    const userDataArg = runInstances?.args[runInstances.args.indexOf("--user-data") + 1] ?? "";
    expect(userDataArg).toMatch(/^file:\/\//);
    const userData = readFileSync(userDataArg.replace(/^file:\/\//, ""), "utf8");
    expect(userData).toContain("postgres:18-alpine");
    expect(userData).toContain("caddy:2");
    expect(userData).toContain("coturn/coturn:latest");
    expect(userData).toContain("docker compose --env-file .env up -d");
    expect(userData).toContain("portal.bootstrap");
    expect(healthCalls).toEqual(["https://deploy.example.test/healthz"]);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["authorize-security-group-ingress", "--protocol", "tcp", "--port", "3478"]) }),
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["authorize-security-group-ingress", "--protocol", "udp", "--port", "3478"]) }),
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["authorize-security-group-ingress", "--protocol", "udp", "--port", "49160-49200"]) })
    ]));
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "create-hosted-zone")).toBe(false);
    expect(calls.some((call) => call.command === "ssh")).toBe(true);
    expect(calls.some((call) => call.command === "direxio-connect" && call.args[1] === "install")).toBe(true);
    expect(calls.some((call) => call.command === "direxio-mcp" && call.args[1] === "install")).toBe(true);
  });

  it("resumes from recorded AWS resources without creating duplicates", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-resume-"));
    const serviceDir = join(home, ".direxio", "nodes", "resume.example.test");
    const keyFile = join(serviceDir, "direxio-resume.pem");
    const calls: Array<{ command: string; args: string[] }> = [];
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        run_id: "direxio-resume",
        region: "us-west-2",
        domain_mode: "route53",
        domain: "resume.example.test",
        phases: {},
        resources: {
          ami_id: "ami-existing",
          sg_id: "sg-existing",
          key_name: "direxio-resume",
          key_file: keyFile,
          instance_id: "i-existing",
          root_volume_id: "vol-existing",
          eip_id: "eipalloc-existing",
          public_ip: "203.0.113.50",
          route53_zone_id: "ZEXISTING",
          route53_zone_name: "resume.example.test"
        }
      }),
      "utf8"
    );

    await deployService({
      homeDir: home,
      serviceId: "resume.example.test",
      domain: "resume.example.test",
      region: "us-west-2",
      agent: "codex",
      mcpTarget: "codex",
      confirmDomainBinding: true,
      runner: async (command, args) => {
        calls.push({ command, args });
        const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
        if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
        if (command === "ssh") {
          return {
            stdout: JSON.stringify({
              password: "12345678",
              access_token: "owner-secret",
              agent_token: "agent-secret",
              agent_room_id: "!agents:resume.example.test"
            }),
            stderr: "",
            exitCode: 0
          };
        }
        if (command === "direxio-connect" && args[1] === "status") return { stdout: `Status: Running\nWorkDir: ${join(serviceDir, "direxio-connect")}\n`, stderr: "", exitCode: 0 };
        if (command === "direxio-connect" && args[1] === "logs") return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async (input, init) => {
        if (String(input) === "https://resume.example.test/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "matrix-agent-token",
          device_id: "DEVRESUME",
          user_id: "@agent:resume.example.test",
          homeserver: "https://resume.example.test"
        }), { status: 200 });
      }
    });

    const duplicateAwsActions = new Set([
      "create-security-group",
      "create-key-pair",
      "run-instances",
      "allocate-address",
      "create-hosted-zone"
    ]);
    expect(calls.filter((call) => call.command === "aws").map((call) => normalizedAwsArgs(call.args)[1])).not.toEqual(
      expect.arrayContaining(Array.from(duplicateAwsActions))
    );
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      phase: "S7_VERIFY_E2E",
      resources: {
        instance_id: "i-existing",
        public_ip: "203.0.113.50",
        route53_zone_id: "ZEXISTING"
      }
    });
  });

  it("persists provisioned resources before a later AWS failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-partial-"));
    const serviceDir = join(home, ".direxio", "nodes", "partial.example.test");

    await expect(
      deployService({
        homeDir: home,
        serviceId: "partial.example.test",
        domain: "partial.example.test",
        region: "us-east-1",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-partial"}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-partial"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-partial","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: "", stderr: "capacity unavailable", exitCode: 1 };
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).rejects.toThrow("capacity unavailable");

    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      phase: "S2_DOMAIN",
      resources: {
        ami_id: "ami-partial",
        sg_id: "sg-partial",
        sg_ingress_configured: true,
        key_name: "direxio-partial",
        key_file: join(serviceDir, "direxio-partial.pem"),
        user_data: join(serviceDir, "user-data.yaml")
      }
    });
  });

  it("requires an explicit AWS region", async () => {
    await expect(
      deployService({
        serviceId: "deploy.example.test",
        domain: "deploy.example.test",
        region: "",
        confirmDomainBinding: true,
        runner: async () => ({ stdout: "", stderr: "", exitCode: 0 })
      })
    ).rejects.toThrow("deploy requires region");
  });
});

function normalizedAwsArgs(args: string[]): string[] {
  return args[0] === "--region" ? args.slice(2) : args;
}
