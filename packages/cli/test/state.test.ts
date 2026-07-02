import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildOperationReport, confirmUserGate, readServiceState, serviceStateFile } from "../src/state.js";

function writeState(home: string): string {
  const serviceDir = join(home, ".direxio", "nodes", "report.example.test");
  mkdirSync(serviceDir, { recursive: true });
  const stateFile = join(serviceDir, "state.json");
  writeFileSync(
    stateFile,
    JSON.stringify({
      run_id: "report-test",
      region: "ap-northeast-1",
      domain_mode: "route53",
      domain: "report.example.test",
      as_url: "https://report.example.test",
      instance_type: "t3.small",
      password: "12345678",
      access_token: "ACCESS_SECRET",
      agent_token: "AGENT_SECRET",
      agent_room_id: "!room:report.example.test",
      agent_node_id: "node-report",
      agent_service_id: "report.example.test",
      agent_service_dir: serviceDir,
      agent_credentials_file: join(serviceDir, "credentials.json"),
      connect_config: join(serviceDir, "direxio-connect", "config.toml"),
      connect_agent: "acp",
      connect_install_status: "installed",
      mcp_npm_package: "direxio-mcp@latest",
      phases: {
        S0_PREREQ_AWS: { status: "done" },
        S7_VERIFY_E2E: { status: "done" }
      },
      user_confirmations: {
        app_initialization: {
          status: "confirmed",
          ts: "2026-06-28T01:02:03Z",
          evidence: "user completed app initialization with code 12345678"
        },
        real_chat: {
          status: "confirmed",
          ts: "2026-06-28T01:03:04Z",
          evidence: "user saw the agent reply; token ACCESS_SECRET stayed local"
        }
      },
      runtime_checks: {
        summary: { status: "passed" }
      },
      resources: {
        instance_id: "i-report",
        root_volume_id: "vol-report-root",
        public_ip: "203.0.113.42",
        route53_zone_id: "ZREPORT"
      }
    }),
    "utf8"
  );
  return stateFile;
}

describe("service state reports", () => {
  it("builds a redacted operation report without leaking local secrets", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-state-"));
    const stateFile = writeState(home);
    const state = JSON.parse(readFileSync(stateFile, "utf8"));

    const report = buildOperationReport("status", "status_report", stateFile, "2026-07-01T00:00:00.000Z", state);
    const serialized = JSON.stringify(report);

    expect(serialized).not.toContain("12345678");
    expect(serialized).not.toContain("ACCESS_SECRET");
    expect(serialized).not.toContain("AGENT_SECRET");
    expect(report).toMatchObject({
      operation_type: "status",
      status: "status_report",
      domain: "report.example.test",
      delivery: {
        init_code_status: "available_in_state_password_field_redacted",
        init_code_secret_redacted: true
      },
      gates: {
        automated: {
          S7_VERIFY_E2E: "done"
        },
        user_confirmation: {
          app_initialization: "confirmed",
          real_chat: "confirmed"
        }
      },
      billing: {
        recorded_billable_resources: expect.arrayContaining([
          "EC2 i-report",
          "EBS root volume vol-report-root",
          "public IPv4 203.0.113.42",
          "Route53 hosted zone ZREPORT"
        ])
      },
      security: {
        secrets_included: false
      }
    });
    expect(report.gates.user_confirmation_details.app_initialization.evidence).toContain("<redacted>");
    expect(report.gates.user_confirmation_details.real_chat.evidence).toContain("<redacted>");
  });

  it("writes user confirmation evidence to state", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-state-"));
    writeState(home);
    const context = {
      serviceId: "report.example.test",
      serviceDir: join(home, ".direxio", "nodes", "report.example.test"),
      credentialsFile: join(home, ".direxio", "nodes", "report.example.test", "credentials.json")
    };

    expect(
      confirmUserGate(context, "app-initialization", "user finished the app initialization flow", {
        now: () => "2026-07-01T01:02:03.000Z"
      })
    ).toEqual({
      gate: "app_initialization",
      status: "confirmed",
      ts: "2026-07-01T01:02:03.000Z"
    });

    expect(readServiceState(context).user_confirmations.app_initialization).toMatchObject({
      status: "confirmed",
      ts: "2026-07-01T01:02:03.000Z",
      evidence: "user finished the app initialization flow"
    });
  });

  it("reports user-managed DNS instructions in status output", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-state-user-dns-"));
    const serviceDir = join(home, ".direxio", "nodes", "user-dns.example.test");
    mkdirSync(serviceDir, { recursive: true });
    const stateFile = join(serviceDir, "state.json");
    const state = {
      domain: "user-dns.example.test",
      domain_mode: "user",
      dns_ready: false,
      agent_service_id: "user-dns.example.test",
      agent_service_dir: serviceDir,
      phases: {
        S3_PROVISION: {
          status: "waiting_user",
          detail: "waiting for DNS A record user-dns.example.test -> 203.0.113.55"
        }
      },
      resources: {
        public_ip: "203.0.113.55",
        user_dns_required: true,
        user_dns_a_record: "user-dns.example.test A 203.0.113.55"
      }
    };

    const report = buildOperationReport("status", "status_report", stateFile, "2026-07-01T00:00:00.000Z", state);

    expect(report.resources).toMatchObject({
      domain_mode: "user",
      dns_ready: false,
      user_dns_required: true,
      user_dns_a_record: "user-dns.example.test A 203.0.113.55"
    });
  });

  it("requires runtime proof before confirming the agent mcp runtime gate", () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-state-"));
    writeState(home);
    const context = {
      serviceId: "report.example.test",
      serviceDir: join(home, ".direxio", "nodes", "report.example.test"),
      credentialsFile: join(home, ".direxio", "nodes", "report.example.test", "credentials.json")
    };

    expect(() =>
      confirmUserGate(context, "agent-mcp-runtime", "runtime probe passed in the selected agent", {
        runtimeProbeConfirmed: false
      })
    ).toThrow("requires runtimeProbeConfirmed=true");
    expect(serviceStateFile(context)).toBe(join(context.serviceDir, "state.json"));
  });
});
