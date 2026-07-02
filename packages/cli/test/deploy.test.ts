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
        cloud: "ec2",
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
          if (command === "direxio-mcp" && args[1] === "status") {
            return { stdout: JSON.stringify({ status: "Running" }), stderr: "", exitCode: 0 };
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
          if (url === "https://deploy.example.test/_p2p/query") {
            return new Response(JSON.stringify({
              room_id: "!agents:deploy.example.test",
              messages: []
            }), { status: 200 });
          }
          return new Response(JSON.stringify({
            access_token: "matrix-agent-token",
            device_id: "DEVDEPLOY",
            user_id: "@agent:deploy.example.test",
            homeserver: "https://deploy.example.test"
          }), { status: 200 });
        },
        dnsResolver: {
          resolve4: async () => ["203.0.113.42"]
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
        root_volume_gb: 50,
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
      },
      {
        url: "https://deploy.example.test/_p2p/query",
        authorization: "Bearer agent-secret",
        body: { action: "mcp.messages.list", params: { room_id: "!agents:deploy.example.test" } }
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
    const runInstancesArgs = normalizedAwsArgs(runInstances?.args ?? []);
    const blockDeviceMappings = JSON.parse(runInstancesArgs[runInstancesArgs.indexOf("--block-device-mappings") + 1] ?? "null");
    expect(blockDeviceMappings).toEqual([
      {
        DeviceName: "/dev/sda1",
        Ebs: {
          VolumeSize: 50,
          VolumeType: "gp3",
          DeleteOnTermination: true
        }
      }
    ]);
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
    const route53Change = calls.find((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "change-resource-record-sets");
    const changeBatch = route53Change?.args[(route53Change?.args.indexOf("--change-batch") ?? -1) + 1] ?? "";
    expect(changeBatch).toMatch(/^file:\/\//);
    expect(JSON.parse(readFileSync(changeBatch.replace(/^file:\/\//, ""), "utf8"))).toMatchObject({
      Changes: [
        {
          Action: "UPSERT",
          ResourceRecordSet: {
            Name: "deploy.example.test.",
            ResourceRecords: [{ Value: "203.0.113.42" }]
          }
        }
      ]
    });
    expect(calls.some((call) => call.command === "ssh")).toBe(true);
    const sshCall = calls.find((call) => call.command === "ssh");
    expect(sshCall?.args.join(" ")).toContain("DOMAIN=deploy.example.test");
    expect(sshCall?.args.join(" ")).not.toContain("'\\''deploy.example.test'\\''");
    expect(calls.some((call) => call.command === "direxio-connect" && call.args[1] === "install")).toBe(true);
    expect(calls.some((call) => call.command === "direxio-mcp" && call.args[1] === "install")).toBe(true);
    expect(calls.some((call) => call.command === "direxio-mcp" && call.args[1] === "status")).toBe(true);
    expect(state.runtime_checks.summary).toMatchObject({ status: "passed" });
  });

  it("defaults new deployments to the Lightsail $12 bundle while keeping the same deploy contract", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-lightsail-"));
    const serviceDir = join(home, ".direxio", "nodes", "lightsail.example.test");
    const calls: Array<{ command: string; args: string[] }> = [];
    let getStaticIpCalls = 0;

    await deployService({
      homeDir: home,
      serviceId: "lightsail.example.test",
      domain: "lightsail.example.test",
      region: "us-east-1",
      domainMode: "user",
      agentInstallMode: "skip",
      confirmDomainBinding: true,
      now: () => "2026-07-02T02:03:04.000Z",
      runner: async (command, args) => {
        calls.push({ command, args });
        const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
        if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[0] === "freetier") {
          return {
            stdout: JSON.stringify({
              freeTierUsages: [
                {
                  service: "Amazon Lightsail",
                  actualUsageAmount: 120,
                  limit: 750,
                  unit: "Hrs"
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
                  transferPerMonthInGb: 3072,
                  cpuCount: 2,
                  supportedPlatforms: ["LINUX_UNIX"]
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
        if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "create-key-pair") {
          return { stdout: JSON.stringify({ name: "direxio-key-lightsail-example-test", privateKeyBase64: "-----BEGIN RSA PRIVATE KEY-----\nLIGHTSAIL_KEY\n-----END RSA PRIVATE KEY-----\n" }), stderr: "", exitCode: 0 };
        }
        if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-instance") {
          return { stdout: JSON.stringify({ instance: { state: { name: "running" } } }), stderr: "", exitCode: 0 };
        }
        if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-static-ip") {
          getStaticIpCalls += 1;
          if (getStaticIpCalls === 1) return { stdout: "", stderr: "NotFoundException", exitCode: 255 };
          return { stdout: JSON.stringify({ staticIp: { ipAddress: "203.0.113.124" } }), stderr: "", exitCode: 0 };
        }
        if (command === "aws" && awsArgs[0] === "lightsail") return { stdout: "{}", stderr: "", exitCode: 0 };
        if (command === "ssh") {
          return {
            stdout: JSON.stringify({
              password: "12345678",
              access_token: "owner-secret",
              agent_token: "agent-secret",
              agent_room_id: "!agents:lightsail.example.test"
            }),
            stderr: "",
            exitCode: 0
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async (input) => {
        if (String(input) === "https://lightsail.example.test/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "matrix-agent-token",
          device_id: "DEVLIGHTSAIL",
          user_id: "@agent:lightsail.example.test",
          homeserver: "https://lightsail.example.test"
        }), { status: 200 });
      },
      dnsResolver: {
        resolve4: async () => ["203.0.113.124"]
      }
    });

    const state = JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"));
    expect(state).toMatchObject({
      cloud_provider: "lightsail",
      domain_mode: "user",
      aws_free_tier: {
        status: "queried"
      },
      cloud_recommendation: {
        default_provider: "lightsail",
        selected_provider: "lightsail",
        recommended_provider: "lightsail"
      },
      resources: {
        instance_id: "direxio-lightsail-example-test",
        lightsail_instance_name: "direxio-lightsail-example-test",
        lightsail_static_ip_name: "direxio-ip-lightsail-example-test",
        lightsail_availability_zone: "us-east-1a",
        lightsail_ports_configured: "true",
        lightsail_bundle_id: "medium_3_0",
        lightsail_bundle_price_usd: 12,
        lightsail_bundle_ram_gb: 2,
        lightsail_bundle_disk_gb: 60,
        public_ip: "203.0.113.124",
        user_dns_a_record: "lightsail.example.test A 203.0.113.124"
      }
    });
    expect(state.cost_estimate).toMatchObject({
      provider: "lightsail",
      total_monthly_usd: 12
    });
    expect(state.billing_warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("three months free")
    ]));
    expect(readFileSync(join(serviceDir, "direxio-key-lightsail-example-test.pem"), "utf8")).toBe("-----BEGIN RSA PRIVATE KEY-----\nLIGHTSAIL_KEY\n-----END RSA PRIVATE KEY-----\n");
    const lightsailUserData = readFileSync(state.resources.user_data, "utf8");
    expect(lightsailUserData).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(lightsailUserData).toContain("set -eu");
    expect(lightsailUserData.split(/\r?\n/).slice(0, 5).join("\n")).not.toContain("pipefail");
    expect(lightsailUserData).not.toContain("#cloud-config");
    expect(lightsailUserData).toContain("cat > /var/direxio-message-server/docker-compose.yml <<'DIREXIO_COMPOSE'");
    expect(lightsailUserData).toContain("docker compose --env-file .env up -d");
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "lightsail" && normalizedAwsArgs(call.args)[1] === "create-instances")).toBe(true);
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "lightsail" && normalizedAwsArgs(call.args)[1] === "get-instance")).toBe(true);
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "ec2" && normalizedAwsArgs(call.args)[1] === "run-instances")).toBe(false);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["open-instance-public-ports", "--port-info", "fromPort=49160,toPort=49200,protocol=udp"]) }),
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["allocate-static-ip", "--static-ip-name", "direxio-ip-lightsail-example-test"]) }),
      expect.objectContaining({ command: "aws", args: expect.arrayContaining(["attach-static-ip", "--static-ip-name", "direxio-ip-lightsail-example-test"]) })
    ]));
  });

  it("selects an available Lightsail zone when the explicit default zone is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-lightsail-zone-"));
    const serviceId = "lightsail-zone.example.test";
    const calls: Array<{ command: string; args: string[] }> = [];
    let getStaticIpCalls = 0;

    await expect(
      deployService({
        homeDir: home,
        serviceId,
        domain: serviceId,
        region: "us-east-1",
        domainMode: "user",
        agentInstallMode: "skip",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-bundles") {
            return { stdout: JSON.stringify({ bundles: [{ bundleId: "medium_3_0", price: 12, ramSizeInGb: 2, diskSizeInGb: 60, supportedPlatforms: ["LINUX_UNIX"] }] }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-regions") {
            return {
              stdout: JSON.stringify({
                regions: [
                  {
                    name: "us-east-1",
                    availabilityZones: [
                      { zoneName: "us-east-1a", state: "unavailable" },
                      { zoneName: "us-east-1b", state: "available" }
                    ]
                  }
                ]
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-static-ip") {
            getStaticIpCalls += 1;
            if (getStaticIpCalls === 1) return { stdout: "", stderr: "NotFoundException", exitCode: 255 };
            return { stdout: JSON.stringify({ staticIp: { ipAddress: "203.0.113.131" } }), stderr: "", exitCode: 0 };
          }
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-instance") {
            return { stdout: JSON.stringify({ instance: { state: { name: "running" } } }), stderr: "", exitCode: 0 };
          }
          return { stdout: "{}", stderr: "", exitCode: 0 };
        },
        dnsResolver: {
          resolve4: async () => []
        }
      })
    ).rejects.toThrow("waiting for DNS A record lightsail-zone.example.test ->");

    const createInstances = calls.find((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "lightsail" && normalizedAwsArgs(call.args)[1] === "create-instances");
    expect(createInstances?.args).toEqual(expect.arrayContaining(["--availability-zone", "us-east-1b"]));
    const state = JSON.parse(readFileSync(join(home, ".direxio", "nodes", serviceId, "state.json"), "utf8"));
    expect(state.resources.lightsail_availability_zone).toBe("us-east-1b");
  });

  it("fails health polling with deploy progress and state evidence instead of hanging silently", async () => {
    const previousMax = process.env.DIREXIO_HEALTH_POLL_MAX;
    const previousInterval = process.env.DIREXIO_HEALTH_POLL_INTERVAL_MS;
    process.env.DIREXIO_HEALTH_POLL_MAX = "2";
    process.env.DIREXIO_HEALTH_POLL_INTERVAL_MS = "1";
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-health-timeout-"));
    const serviceId = "health-timeout.example.test";
    const serviceDir = join(home, ".direxio", "nodes", serviceId);
    const keyFile = join(serviceDir, "direxio-health-timeout.pem");
    const progress: string[] = [];
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        run_id: "direxio-health-timeout",
        region: "us-east-1",
        cloud_provider: "ec2",
        domain_mode: "user",
        domain: serviceId,
        phases: {},
        resources: {
          ami_id: "ami-health-timeout",
          sg_id: "sg-health-timeout",
          key_name: "direxio-health-timeout",
          key_file: keyFile,
          instance_id: "i-health-timeout",
          root_volume_id: "vol-health-timeout",
          eip_id: "eipalloc-health-timeout",
          public_ip: "203.0.113.68"
        }
      }),
      "utf8"
    );

    try {
      await expect(
        deployService({
          homeDir: home,
          serviceId,
          domain: serviceId,
          region: "us-east-1",
          cloud: "ec2",
          agentInstallMode: "skip",
          confirmDomainBinding: true,
          onProgress: (event) => progress.push(`${event.phase}:${event.status}:${event.message}`),
          runner: async (command, args) => {
            const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
            if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
            return { stdout: "", stderr: "", exitCode: 0 };
          },
          fetch: async () => new Response("not ready", { status: 503 }),
          dnsResolver: {
            resolve4: async () => ["203.0.113.68"]
          }
        })
      ).rejects.toThrow("healthz did not return 200 before timeout");
    } finally {
      restoreEnv("DIREXIO_HEALTH_POLL_MAX", previousMax);
      restoreEnv("DIREXIO_HEALTH_POLL_INTERVAL_MS", previousInterval);
    }

    expect(progress).toEqual(expect.arrayContaining([
      expect.stringContaining("S4_BOOTSTRAP_STACK:waiting:waiting for https://health-timeout.example.test/healthz"),
      expect.stringContaining("S4_BOOTSTRAP_STACK:failed:healthz did not return 200 before timeout")
    ]));
    const state = JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"));
    expect(state).toMatchObject({
      phase: "S4_BOOTSTRAP_STACK",
      phases: {
        S4_BOOTSTRAP_STACK: {
          status: "failed"
        }
      }
    });
    expect(state.deploy_error).toContain("healthz did not return 200 before timeout");
  });

  it("falls back to public recursive DNS when the local Node resolver refuses queries", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-dns-fallback-"));
    const serviceId = "dns-fallback.example.test";
    const serviceDir = join(home, ".direxio", "nodes", serviceId);
    const keyFile = join(serviceDir, "direxio-dns-fallback.pem");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        run_id: "direxio-dns-fallback",
        region: "us-east-1",
        cloud_provider: "ec2",
        domain_mode: "user",
        domain: serviceId,
        phases: {},
        resources: {
          ami_id: "ami-dns-fallback",
          sg_id: "sg-dns-fallback",
          key_name: "direxio-dns-fallback",
          key_file: keyFile,
          instance_id: "i-dns-fallback",
          root_volume_id: "vol-dns-fallback",
          eip_id: "eipalloc-dns-fallback",
          public_ip: "203.0.113.69"
        }
      }),
      "utf8"
    );

    await deployService({
      homeDir: home,
      serviceId,
      domain: serviceId,
      region: "us-east-1",
      cloud: "ec2",
      agentInstallMode: "skip",
      confirmDomainBinding: true,
      runner: async (command, args) => {
        const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
        if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
        if (command === "ssh") return { stdout: `{"password":"12345678","access_token":"owner","agent_token":"agent","agent_room_id":"!agents:${serviceId}"}`, stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async (input) => {
        if (String(input) === `https://${serviceId}/healthz`) {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "matrix-token",
          device_id: "DEVDNS",
          user_id: `@agent:${serviceId}`,
          homeserver: `https://${serviceId}`
        }), { status: 200 });
      },
      dnsResolver: {
        resolveNs: async () => {
          throw new Error("ECONNREFUSED");
        },
        resolve4: async () => {
          throw new Error("ECONNREFUSED");
        },
        resolve4At: async (server) => (server === "1.1.1.1" ? ["203.0.113.69"] : [])
      }
    });

    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      dns_ready: true,
      phase: "S7_VERIFY_E2E"
    });
  });

  it("does not silently switch a confirmed Lightsail deploy to EC2 when no Lightsail zone is available", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-lightsail-no-zone-"));
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      deployService({
        homeDir: home,
        serviceId: "no-zone.example.test",
        domain: "no-zone.example.test",
        region: "us-east-1",
        cloud: "lightsail",
        domainMode: "user",
        agentInstallMode: "skip",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "lightsail" && awsArgs[1] === "get-bundles") {
            return { stdout: JSON.stringify({ bundles: [{ bundleId: "medium_3_0", price: 12, ramSizeInGb: 2, diskSizeInGb: 60, supportedPlatforms: ["LINUX_UNIX"] }] }), stderr: "", exitCode: 0 };
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
      })
    ).rejects.toThrow("no available Lightsail availability zone found for region us-east-1");

    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "ec2")).toBe(false);
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "lightsail" && normalizedAwsArgs(call.args)[1] === "create-instances")).toBe(false);
  });

  it("does not implicitly resume EC2 state when the deploy request uses the default cloud", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-existing-ec2-default-"));
    const serviceId = "existing-ec2.example.test";
    const serviceDir = join(home, ".direxio", "nodes", serviceId);
    const keyFile = join(serviceDir, "direxio-existing-ec2.pem");
    const calls: Array<{ command: string; args: string[] }> = [];
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        run_id: "direxio-existing-ec2",
        region: "us-east-1",
        domain_mode: "user",
        domain: serviceId,
        phases: {},
        resources: {
          ami_id: "ami-existing-ec2",
          sg_id: "sg-existing-ec2",
          key_name: "direxio-existing-ec2",
          key_file: keyFile,
          instance_id: "i-existing-ec2",
          root_volume_id: "vol-existing-ec2",
          eip_id: "eipalloc-existing-ec2",
          public_ip: "203.0.113.72"
        }
      }),
      "utf8"
    );

    await expect(
      deployService({
        homeDir: home,
        serviceId,
        domain: serviceId,
        region: "us-east-1",
        agent: "codex",
        agentInstallMode: "skip",
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
                agent_room_id: `!agents:${serviceId}`
              }),
              stderr: "",
              exitCode: 0
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async (input) => {
          if (String(input) === `https://${serviceId}/healthz`) {
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          return new Response(JSON.stringify({
            access_token: "matrix-token",
            device_id: "DEVEXISTING",
            user_id: `@agent:${serviceId}`,
            homeserver: `https://${serviceId}`
          }), { status: 200 });
        },
        dnsResolver: {
          resolve4: async () => ["203.0.113.72"]
        }
      })
    ).rejects.toThrow("state is bound to cloud_provider=ec2; refusing requested cloud_provider=lightsail");

    expect(calls.some((call) => call.command === "ssh")).toBe(false);
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
      cloud: "ec2",
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
        if (command === "direxio-mcp" && args[1] === "status") return { stdout: '{"status":"Running"}', stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async (input, init) => {
        if (String(input) === "https://resume.example.test/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        if (String(input) === "https://resume.example.test/_p2p/query") {
          return new Response(JSON.stringify({ room_id: "!agents:resume.example.test", messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "matrix-agent-token",
          device_id: "DEVRESUME",
          user_id: "@agent:resume.example.test",
          homeserver: "https://resume.example.test"
        }), { status: 200 });
      },
      dnsResolver: {
        resolve4: async () => ["203.0.113.50"]
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
      cloud: "ec2",
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
      phase: "S3_PROVISION",
      phases: {
        S3_PROVISION: {
          status: "failed",
          detail: "capacity unavailable"
        }
      },
      deploy_error: "capacity unavailable",
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

  it("auto-selects user-managed DNS when Route53 has no public matching hosted zone", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-user-dns-"));
    const serviceDir = join(home, ".direxio", "nodes", "manual-dns.example.test");
    const calls: Array<{ command: string; args: string[] }> = [];
    const healthCalls: string[] = [];

    await expect(
      deployService({
        homeDir: home,
        serviceId: "manual-dns.example.test",
        domain: "manual-dns.example.test",
        region: "us-east-1",
        cloud: "ec2",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-user-dns"}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-user-dns"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-user-dns","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: '{"Instances":[{"InstanceId":"i-user-dns","BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-user-dns"}}]}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "allocate-address") return { stdout: '{"AllocationId":"eipalloc-user-dns","PublicIp":"203.0.113.77"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-hosted-zones") {
            return {
              stdout: '{"HostedZones":[{"Id":"/hostedzone/ZPRIVATE","Name":"manual-dns.example.test.","Config":{"PrivateZone":true}}]}',
              stderr: "",
              exitCode: 0
            };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async (input) => {
          healthCalls.push(String(input));
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        },
        dnsResolver: {
          resolve4: async () => []
        }
      })
    ).rejects.toThrow("waiting for DNS A record manual-dns.example.test -> 203.0.113.77");

    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "create-hosted-zone")).toBe(false);
    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "change-resource-record-sets")).toBe(false);
    expect(calls.some((call) => call.command === "ssh")).toBe(false);
    expect(healthCalls).toEqual([]);
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      domain_mode: "user",
      dns_ready: false,
      phases: {
        S3_PROVISION: {
          status: "waiting_user",
          detail: "waiting for DNS A record manual-dns.example.test -> 203.0.113.77"
        }
      },
      resources: {
        public_ip: "203.0.113.77",
        user_dns_required: true,
        user_dns_a_record: "manual-dns.example.test A 203.0.113.77"
      }
    });
  });

  it("blocks Route53 A record overwrite until the operator confirms it", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-route53-overwrite-"));
    const serviceDir = join(home, ".direxio", "nodes", "overwrite.example.test");
    const calls: Array<{ command: string; args: string[] }> = [];

    await expect(
      deployService({
        homeDir: home,
        serviceId: "overwrite.example.test",
        domain: "overwrite.example.test",
        region: "us-east-1",
        cloud: "ec2",
        domainMode: "route53",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          calls.push({ command, args });
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-overwrite"}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-overwrite"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-overwrite","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: '{"Instances":[{"InstanceId":"i-overwrite","BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-overwrite"}}]}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[1] === "allocate-address") return { stdout: '{"AllocationId":"eipalloc-overwrite","PublicIp":"203.0.113.88"}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-hosted-zones") return { stdout: '{"HostedZones":[{"Id":"/hostedzone/ZOVERWRITE","Name":"overwrite.example.test."}]}', stderr: "", exitCode: 0 };
          if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-resource-record-sets") return { stdout: '{"ResourceRecordSets":[{"Name":"overwrite.example.test.","Type":"A","ResourceRecords":[{"Value":"198.51.100.10"}]}]}', stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        dnsResolver: {
          resolve4: async () => ["198.51.100.10"]
        }
      })
    ).rejects.toThrow("Route53 A record overwrite requires confirmation");

    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "change-resource-record-sets")).toBe(false);
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      domain_mode: "route53",
      phases: {
        S3_PROVISION: {
          status: "waiting_user",
          detail: "Route53 A record overwrite requires confirmation"
        }
      },
      resources: {
        route53_zone_id: "ZOVERWRITE",
        route53_existing_a_value: "198.51.100.10",
        route53_pending_a_value: "203.0.113.88"
      }
    });
  });

  it("overwrites a Route53 A record after explicit confirmation", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-route53-confirmed-"));
    const serviceDir = join(home, ".direxio", "nodes", "confirmed-overwrite.example.test");
    const calls: Array<{ command: string; args: string[] }> = [];
    const fetchCalls: string[] = [];

    await deployService({
      homeDir: home,
      serviceId: "confirmed-overwrite.example.test",
      domain: "confirmed-overwrite.example.test",
      region: "us-east-1",
      cloud: "ec2",
      domainMode: "route53",
      confirmDomainBinding: true,
      confirmDnsOverwrite: true,
      runner: async (command, args) => {
        calls.push({ command, args });
        const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
        if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[0] === "ssm") return { stdout: '{"Parameters":[{"Value":"ami-confirmed"}]}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[1] === "create-security-group") return { stdout: '{"GroupId":"sg-confirmed"}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[1] === "create-key-pair") return { stdout: '{"KeyName":"direxio-confirmed","KeyMaterial":"PRIVATE"}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[1] === "run-instances") return { stdout: '{"Instances":[{"InstanceId":"i-confirmed","BlockDeviceMappings":[{"Ebs":{"VolumeId":"vol-confirmed"}}]}]}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[1] === "allocate-address") return { stdout: '{"AllocationId":"eipalloc-confirmed","PublicIp":"203.0.113.92"}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-hosted-zones") return { stdout: '{"HostedZones":[{"Id":"/hostedzone/ZCONFIRMED","Name":"confirmed-overwrite.example.test."}]}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "list-resource-record-sets") return { stdout: '{"ResourceRecordSets":[{"Name":"confirmed-overwrite.example.test.","Type":"A","ResourceRecords":[{"Value":"198.51.100.11"}]}]}', stderr: "", exitCode: 0 };
        if (command === "aws" && awsArgs[0] === "route53" && awsArgs[1] === "change-resource-record-sets") return { stdout: '{"ChangeInfo":{"Id":"/change/CUPSERT"}}', stderr: "", exitCode: 0 };
        if (command === "ssh") return { stdout: '{"password":"12345678","access_token":"owner","agent_token":"agent","agent_room_id":"!agents:confirmed-overwrite.example.test"}', stderr: "", exitCode: 0 };
        if (command === "direxio-connect" && args[1] === "status") return { stdout: `Status: Running\nWorkDir: ${join(serviceDir, "direxio-connect")}\n`, stderr: "", exitCode: 0 };
        if (command === "direxio-connect" && args[1] === "logs") return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
        if (command === "direxio-mcp" && args[1] === "status") return { stdout: '{"status":"Running"}', stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      fetch: async (input) => {
        fetchCalls.push(String(input));
        if (String(input) === "https://confirmed-overwrite.example.test/healthz") {
          return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
        }
        if (String(input) === "https://confirmed-overwrite.example.test/_p2p/query") {
          return new Response(JSON.stringify({ room_id: "!agents:confirmed-overwrite.example.test", messages: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          access_token: "matrix-token",
          device_id: "DEV",
          user_id: "@agent:confirmed-overwrite.example.test",
          homeserver: "https://confirmed-overwrite.example.test"
        }), { status: 200 });
      },
      dnsResolver: {
        resolve4: async () => ["203.0.113.92"]
      }
    });

    expect(calls.some((call) => call.command === "aws" && normalizedAwsArgs(call.args)[0] === "route53" && normalizedAwsArgs(call.args)[1] === "change-resource-record-sets")).toBe(true);
    expect(calls).toContainEqual(expect.objectContaining({
      command: "aws",
      args: expect.arrayContaining(["route53", "wait", "resource-record-sets-changed", "--id", "CUPSERT"])
    }));
    expect(fetchCalls).toContain("https://confirmed-overwrite.example.test/healthz");
    expect(JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))).toMatchObject({
      dns_ready: true,
      resources: {
        route53_existing_a_value: "198.51.100.11",
        route53_pending_a_value: "203.0.113.92",
        route53_overwrite_confirmed: "true"
      }
    });
  });

  it("recommends local install commands without starting daemons when requested", async () => {
    const { calls, serviceDir, state } = await runDeploymentWithLocalInstallMode("recommend");

    expect(calls.some((call) => call.command === "npm")).toBe(false);
    expect(calls.some((call) => call.command === "direxio-connect")).toBe(false);
    expect(calls.some((call) => call.command === "direxio-mcp")).toBe(false);
    expect(existsSync(join(serviceDir, "direxio-connect", "config.toml"))).toBe(true);
    expect(existsSync(join(serviceDir, "mcp", "codex.toml"))).toBe(true);
    expect(state).toMatchObject({
      local_install_mode: "recommend",
      connect_install_policy: "recommend",
      connect_install_status: "recommended",
      mcp_install_status: "recommended",
      mcp_daemon_install_status: "not_installed",
      local_install_commands: [
        "direxio connect install --service local-install-recommend.example.test",
        "direxio mcp install --service local-install-recommend.example.test --target codex",
        "direxio verify runtime --service local-install-recommend.example.test"
      ]
    });
  });

  it("uses the selected provider as the default MCP target", async () => {
    const { serviceDir, state } = await runDeploymentWithLocalInstallMode("recommend", "gemini");

    expect(existsSync(join(serviceDir, "mcp", "gemini.mcp.json"))).toBe(true);
    expect(existsSync(join(serviceDir, "mcp", "codex.toml"))).toBe(false);
    expect(state).toMatchObject({
      agent_runtime: "gemini",
      local_install_commands: [
        "direxio connect install --service local-install-recommend.example.test",
        "direxio mcp install --service local-install-recommend.example.test --target gemini",
        "direxio verify runtime --service local-install-recommend.example.test"
      ],
      mcp_target_artifacts: {
        gemini: join(serviceDir, "mcp", "gemini.mcp.json")
      }
    });
  });

  it("skips local runtime installs while still writing credentials and connect config", async () => {
    const { calls, serviceDir, state } = await runDeploymentWithLocalInstallMode("skip");

    expect(calls.some((call) => call.command === "npm")).toBe(false);
    expect(calls.some((call) => call.command === "direxio-connect")).toBe(false);
    expect(calls.some((call) => call.command === "direxio-mcp")).toBe(false);
    expect(existsSync(join(serviceDir, "credentials.json"))).toBe(true);
    expect(existsSync(join(serviceDir, "direxio-connect", "config.toml"))).toBe(true);
    expect(existsSync(join(serviceDir, "mcp", "codex.toml"))).toBe(false);
    expect(state).toMatchObject({
      local_install_mode: "skip",
      connect_install_policy: "skip",
      connect_install_status: "skipped",
      mcp_install_status: "skipped",
      mcp_daemon_install_status: "not_installed",
      local_install_commands: []
    });
  });

  it("uses provider-owned connect defaults when writing local config", async () => {
    const { serviceDir, state } = await runDeploymentWithLocalInstallMode("skip", "reasonix");

    const connectConfig = readFileSync(join(serviceDir, "direxio-connect", "config.toml"), "utf8");
    expect(connectConfig).toContain('type = "reasonix"');
    expect(connectConfig).toContain('serve_url = "http://127.0.0.1:8719"');
    expect(state).toMatchObject({
      agent_runtime: "reasonix",
      connect_agent: "reasonix"
    });
  });

  it("does not complete deploy when post-install runtime verification fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-deploy-runtime-fail-"));
    const serviceId = "runtime-fail.example.test";
    const serviceDir = join(home, ".direxio", "nodes", serviceId);
    const keyFile = join(serviceDir, "direxio-runtime-fail.pem");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        run_id: "direxio-runtime-fail",
        region: "us-east-1",
        domain_mode: "user",
        domain: serviceId,
        phases: {},
        resources: {
          ami_id: "ami-runtime-fail",
          sg_id: "sg-runtime-fail",
          key_name: "direxio-runtime-fail",
          key_file: keyFile,
          instance_id: "i-runtime-fail",
          root_volume_id: "vol-runtime-fail",
          eip_id: "eipalloc-runtime-fail",
          public_ip: "203.0.113.67"
        }
      }),
      "utf8"
    );

    await expect(
      deployService({
        homeDir: home,
        serviceId,
        domain: serviceId,
        region: "us-east-1",
        cloud: "ec2",
        agent: "codex",
        mcpTarget: "codex",
        confirmDomainBinding: true,
        runner: async (command, args) => {
          const awsArgs = command === "aws" ? normalizedAwsArgs(args) : args;
          if (command === "aws" && awsArgs[0] === "sts") return { stdout: "{}", stderr: "", exitCode: 0 };
          if (command === "ssh") {
            return {
              stdout: JSON.stringify({
                password: "12345678",
                access_token: "owner-secret",
                agent_token: "agent-secret",
                agent_room_id: `!agents:${serviceId}`
              }),
              stderr: "",
              exitCode: 0
            };
          }
          if (command === "direxio-connect" && args[1] === "status") return { stdout: `Status: Running\nWorkDir: ${join(serviceDir, "direxio-connect")}\n`, stderr: "", exitCode: 0 };
          if (command === "direxio-connect" && args[1] === "logs") return { stdout: "direxio-connect is running\n", stderr: "", exitCode: 0 };
          if (command === "direxio-mcp" && args[1] === "status") return { stdout: '{"status":"Running"}', stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        fetch: async (input) => {
          if (String(input) === `https://${serviceId}/healthz`) {
            return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
          }
          if (String(input) === `https://${serviceId}/_p2p/query`) {
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          return new Response(JSON.stringify({
            access_token: "matrix-token",
            device_id: "DEVFAIL",
            user_id: `@agent:${serviceId}`,
            homeserver: `https://${serviceId}`
          }), { status: 200 });
        },
        dnsResolver: {
          resolve4: async () => ["203.0.113.67"]
        }
      })
    ).rejects.toThrow("runtime verification failed after local install");

    const state = JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"));
    expect(state.phase).not.toBe("S7_VERIFY_E2E");
    expect(state.runtime_checks.summary).toMatchObject({
      status: "failed",
      checks: {
        mcp_smoke: "failed"
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function runDeploymentWithLocalInstallMode(mode: "recommend" | "skip", agent = "codex"): Promise<{
  calls: Array<{ command: string; args: string[] }>;
  serviceDir: string;
  state: any;
}> {
  const home = mkdtempSync(join(tmpdir(), `direxio-cli-deploy-local-${mode}-`));
  const serviceId = `local-install-${mode}.example.test`;
  const serviceDir = join(home, ".direxio", "nodes", serviceId);
  const keyFile = join(serviceDir, `direxio-local-${mode}.pem`);
  const calls: Array<{ command: string; args: string[] }> = [];
  mkdirSync(serviceDir, { recursive: true });
  writeFileSync(keyFile, "PRIVATE_KEY", "utf8");
  writeFileSync(
    join(serviceDir, "state.json"),
    JSON.stringify({
      run_id: `direxio-local-${mode}`,
      region: "us-east-1",
      domain_mode: "user",
      domain: serviceId,
      phases: {},
      resources: {
        ami_id: `ami-local-${mode}`,
        sg_id: `sg-local-${mode}`,
        key_name: `direxio-local-${mode}`,
        key_file: keyFile,
        instance_id: `i-local-${mode}`,
        root_volume_id: `vol-local-${mode}`,
        eip_id: `eipalloc-local-${mode}`,
        public_ip: "203.0.113.66"
      }
    }),
    "utf8"
  );

  await deployService({
    homeDir: home,
    serviceId,
    domain: serviceId,
    region: "us-east-1",
    cloud: "ec2",
    agent,
    agentInstallMode: mode,
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
            agent_room_id: `!agents:${serviceId}`
          }),
          stderr: "",
          exitCode: 0
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    fetch: async (input) => {
      if (String(input) === `https://${serviceId}/healthz`) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(JSON.stringify({
        access_token: "matrix-token",
        device_id: "DEVLOCAL",
        user_id: `@agent:${serviceId}`,
        homeserver: `https://${serviceId}`
      }), { status: 200 });
    },
    dnsResolver: {
      resolve4: async () => ["203.0.113.66"]
    }
  });

  return {
    calls,
    serviceDir,
    state: JSON.parse(readFileSync(join(serviceDir, "state.json"), "utf8"))
  };
}
