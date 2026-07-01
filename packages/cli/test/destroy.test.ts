import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { destroyService } from "../src/destroy.js";

describe("destroy operation", () => {
  it("cleans recorded local and AWS resources and writes a destroy report outside the service dir", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-destroy-"));
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
        connect_binary: "direxio-connect",
        resources: {
          instance_id: "i-destroy",
          root_volume_id: "vol-destroy",
          public_ip: "203.0.113.42",
          eip_id: "eipalloc-destroy",
          sg_id: "sg-destroy",
          key_name: "direxio-destroy",
          route53_zone_id: "ZDESTROY",
          route53_zone_created_by_deployer: "true"
        }
      }),
      "utf8"
    );
    writeFileSync(join(connectDir, "config.toml"), "config = true\n", "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];
    let route53ChangeBatchContent = "";

    await expect(
      destroyService({
        serviceId: "destroy.example.test",
        serviceDir,
        credentialsFile: join(serviceDir, "credentials.json")
      }, {
        now: () => "2026-07-01T04:05:06.000Z",
        runner: async (command, args) => {
          calls.push({ command, args });
          if (command === "aws" && args[0] === "route53" && args[1] === "change-resource-record-sets") {
            const changeBatch = args[args.indexOf("--change-batch") + 1] ?? "";
            route53ChangeBatchContent = readFileSync(changeBatch.replace(/^file:\/\//, ""), "utf8");
          }
          if (command === "direxio-connect" && args[1] === "status") {
            return { stdout: `Status: Running\nWorkDir: ${connectDir}\n`, stderr: "", exitCode: 0 };
          }
          if (command === "aws" && args[1] === "describe-volumes") {
            return { stdout: "", stderr: "not found", exitCode: 255 };
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }
      })
    ).resolves.toEqual({
      ok: true,
      operation: "destroy",
      report: join(home, ".direxio", "reports", "destroy.example.test", "operation-report.json")
    });

    expect(calls.some((call) => call.command === "direxio-connect" && call.args[1] === "stop")).toBe(true);
    const route53Change = calls.find((call) => call.command === "aws" && call.args[0] === "route53" && call.args[1] === "change-resource-record-sets");
    const changeBatch = route53Change?.args[(route53Change?.args.indexOf("--change-batch") ?? -1) + 1] ?? "";
    expect(changeBatch).toMatch(/^file:\/\//);
    expect(JSON.parse(route53ChangeBatchContent)).toMatchObject({
      Changes: [{ Action: "DELETE", ResourceRecordSet: { Name: "destroy.example.test." } }]
    });
    expect(calls).toEqual(
      expect.arrayContaining([
        { command: "aws", args: ["ec2", "terminate-instances", "--instance-ids", "i-destroy"] },
        { command: "aws", args: ["ec2", "wait", "instance-terminated", "--instance-ids", "i-destroy"] },
        { command: "aws", args: ["ec2", "release-address", "--allocation-id", "eipalloc-destroy"] },
        { command: "aws", args: ["ec2", "delete-security-group", "--group-id", "sg-destroy"] },
        { command: "aws", args: ["ec2", "delete-key-pair", "--key-name", "direxio-destroy"] },
        { command: "aws", args: ["route53", "delete-hosted-zone", "--id", "ZDESTROY"] }
      ])
    );
    const reportPath = join(home, ".direxio", "reports", "destroy.example.test", "operation-report.json");
    expect(existsSync(reportPath)).toBe(true);
    expect(existsSync(serviceDir)).toBe(false);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      operation_type: "destroy",
      status: "destroy_processed",
      destroy: {
        evidence: {
          ec2_instance: { status: "terminated" },
          ebs_root_volume: { status: "deleted" },
          elastic_ip: { status: "released" },
          security_group: { status: "deleted" },
          key_pair: { status: "deleted" },
          route53_hosted_zone: { status: "deleted" }
        }
      },
      billing: {
        destroy_cleanup_status: "no_recorded_billable_resource_residue"
      },
      security: {
        secrets_included: false
      }
    });
  });

  it("does not delete a parent Route53 zone it did not create", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-destroy-parent-zone-"));
    const serviceDir = join(home, ".direxio", "nodes", "q10.direxio.ai");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "state.json"),
      JSON.stringify({
        domain: "q10.direxio.ai",
        agent_service_id: "q10.direxio.ai",
        agent_service_dir: serviceDir,
        resources: {
          public_ip: "203.0.113.43",
          route53_zone_id: "ZPARENT",
          route53_zone_name: "direxio.ai",
          route53_zone_created_by_deployer: "false"
        }
      }),
      "utf8"
    );
    const calls: Array<{ command: string; args: string[] }> = [];

    await destroyService({
      serviceId: "q10.direxio.ai",
      serviceDir,
      credentialsFile: join(serviceDir, "credentials.json")
    }, {
      runner: async (command, args) => {
        calls.push({ command, args });
        return { stdout: "", stderr: "", exitCode: 0 };
      }
    });

    expect(calls.some((call) => call.command === "aws" && call.args[0] === "route53" && call.args[1] === "change-resource-record-sets")).toBe(true);
    expect(calls.some((call) => call.command === "aws" && call.args[0] === "route53" && call.args[1] === "delete-hosted-zone")).toBe(false);
    const reportPath = join(home, ".direxio", "reports", "q10.direxio.ai", "operation-report.json");
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toMatchObject({
      destroy: {
        evidence: {
          route53_a_record: { status: "deleted" },
          route53_hosted_zone: { status: "skipped" }
        }
      }
    });
  });
});
