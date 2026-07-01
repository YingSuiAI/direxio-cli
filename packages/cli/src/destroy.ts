import { chmodSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { connectStatus, defaultRunner, type CommandResult, type CommandRunner } from "./connect.js";
import type { ServiceContext } from "./service-context.js";
import { buildOperationReport, readServiceState, serviceStateFile, type ServiceState } from "./state.js";

export interface DestroyOptions {
  runner?: CommandRunner;
  now?: () => string;
}

export interface DestroyResult {
  ok: true;
  operation: "destroy";
  report: string;
}

export async function destroyService(context: ServiceContext, options: DestroyOptions = {}): Promise<DestroyResult> {
  const state = readServiceState(context);
  const ts = options.now?.() ?? new Date().toISOString();

  await stopScopedConnectDaemon(context, state, options);
  await destroyAwsResources(state, options, ts);
  const report = writeDestroyReport(context, state, ts);
  removeServiceDir(context);
  return { ok: true, operation: "destroy", report };
}

async function destroyAwsResources(state: ServiceState, options: DestroyOptions, ts: string): Promise<void> {
  const resources = state.resources ?? {};
  if (resources.instance_id) {
    await runAws(options, ["ec2", "terminate-instances", "--instance-ids", String(resources.instance_id)]);
    await runAws(options, ["ec2", "wait", "instance-terminated", "--instance-ids", String(resources.instance_id)]);
    recordEvidence(state, "ec2_instance", "terminated", String(resources.instance_id), ts);
  } else {
    recordEvidence(state, "ec2_instance", "skipped", "no instance_id recorded", ts);
  }

  if (resources.root_volume_id) {
    const result = await tryAws(options, ["ec2", "describe-volumes", "--volume-ids", String(resources.root_volume_id)]);
    recordEvidence(state, "ebs_root_volume", result.exitCode === 0 ? "still_present" : "deleted", String(resources.root_volume_id), ts);
  } else {
    recordEvidence(state, "ebs_root_volume", "skipped", "no root_volume_id recorded", ts);
  }

  if (resources.eip_id) {
    await runAws(options, ["ec2", "release-address", "--allocation-id", String(resources.eip_id)]);
    recordEvidence(state, "elastic_ip", "released", String(resources.eip_id), ts);
  } else {
    recordEvidence(state, "elastic_ip", "skipped", "no eip_id recorded", ts);
  }

  if (resources.sg_id) {
    await runAws(options, ["ec2", "delete-security-group", "--group-id", String(resources.sg_id)]);
    recordEvidence(state, "security_group", "deleted", String(resources.sg_id), ts);
  } else {
    recordEvidence(state, "security_group", "skipped", "no sg_id recorded", ts);
  }

  if (resources.key_name) {
    await runAws(options, ["ec2", "delete-key-pair", "--key-name", String(resources.key_name)]);
    recordEvidence(state, "key_pair", "deleted", String(resources.key_name), ts);
  } else {
    recordEvidence(state, "key_pair", "skipped", "no key_name recorded", ts);
  }

  if (resources.route53_zone_id) {
    if (state.domain && resources.public_ip) {
      await runAws(options, [
        "route53",
        "change-resource-record-sets",
        "--hosted-zone-id",
        String(resources.route53_zone_id),
        "--change-batch",
        `file://${writeRoute53DeleteBatch(state, String(state.domain), String(resources.public_ip))}`
      ]);
      recordEvidence(state, "route53_a_record", "deleted", `${state.domain} ${resources.public_ip}`, ts);
    } else {
      recordEvidence(state, "route53_a_record", "skipped", "missing domain or public_ip", ts);
    }
    if (String(resources.route53_zone_created_by_deployer) === "true") {
      await runAws(options, ["route53", "delete-hosted-zone", "--id", String(resources.route53_zone_id)]);
      recordEvidence(state, "route53_hosted_zone", "deleted", String(resources.route53_zone_id), ts);
    } else {
      recordEvidence(state, "route53_hosted_zone", "skipped", "parent or user-managed hosted zone not deleted", ts);
    }
  } else {
    recordEvidence(state, "route53_a_record", "skipped", "no route53_zone_id recorded", ts);
    recordEvidence(state, "route53_hosted_zone", "skipped", "no route53_zone_id recorded", ts);
  }
}

async function stopScopedConnectDaemon(context: ServiceContext, state: ServiceState, options: DestroyOptions): Promise<void> {
  const binary = String(state.connect_binary || "direxio-connect");
  const serviceName = String(state.agent_service_id || state.domain || context.serviceId || "direxio-connect");
  const expectedWorkDir = state.connect_config ? dirname(String(state.connect_config)) : join(context.serviceDir, "direxio-connect");
  try {
    const status = await connectStatus(serviceName, { runner: options.runner, binary });
    if (status.status === "Running" && status.work_dir && pathsEqual(status.work_dir, expectedWorkDir)) {
      await runCommand(options, binary, ["daemon", "stop", "--service-name", serviceName]);
    }
  } catch {
    return;
  }
}

async function runAws(options: DestroyOptions, args: string[]): Promise<CommandResult> {
  const result = await tryAws(options, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `aws exited with ${result.exitCode}`).trim());
  }
  return result;
}

async function tryAws(options: DestroyOptions, args: string[]): Promise<CommandResult> {
  const runner = options.runner ?? defaultRunner;
  return runner("aws", args);
}

async function runCommand(options: DestroyOptions, command: string, args: string[]): Promise<void> {
  const runner = options.runner ?? defaultRunner;
  const result = await runner(command, args);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `${command} exited with ${result.exitCode}`).trim());
  }
}

function recordEvidence(state: ServiceState, key: string, status: string, detail: string, ts: string): void {
  if (!state.destroy_evidence || typeof state.destroy_evidence !== "object") state.destroy_evidence = {};
  state.destroy_evidence[key] = { status, detail, checked_at: ts };
}

function writeDestroyReport(context: ServiceContext, state: ServiceState, generatedAt: string): string {
  const reportPath = destroyReportFile(context);
  mkdirSync(dirname(reportPath), { recursive: true });
  const report = buildOperationReport("destroy", "destroy_processed", serviceStateFile(context), generatedAt, state);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function destroyReportFile(context: ServiceContext): string {
  const direxioRoot = dirname(dirname(context.serviceDir));
  return join(direxioRoot, "reports", context.serviceId, "operation-report.json");
}

function removeServiceDir(context: ServiceContext): void {
  if (!isSafeServiceDir(context.serviceDir)) {
    throw new Error(`refusing to remove unsafe service directory: ${context.serviceDir}`);
  }
  makeTreeWritable(context.serviceDir);
  rmSync(context.serviceDir, { recursive: true, force: true });
}

function isSafeServiceDir(serviceDir: string): boolean {
  const normalized = normalize(serviceDir).replace(/\\/g, "/");
  return normalized.includes("/.direxio/nodes/") && basename(normalized).length > 0;
}

function route53DeleteARecordBatch(domain: string, ip: string): string {
  return JSON.stringify({
    Changes: [
      {
        Action: "DELETE",
        ResourceRecordSet: {
          Name: `${domain.replace(/\.+$/, "")}.`,
          Type: "A",
          TTL: 60,
          ResourceRecords: [{ Value: ip }]
        }
      }
    ]
  });
}

function makeTreeWritable(target: string): void {
  try {
    const stat = statSync(target);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(target)) makeTreeWritable(join(target, entry));
    }
    chmodSync(target, 0o700);
  } catch {
    return;
  }
}

function writeRoute53DeleteBatch(state: ServiceState, domain: string, ip: string): string {
  const serviceDir = String(state.agent_service_dir || "");
  const file = join(serviceDir, "route53-delete-a.json");
  writeFileSync(file, `${route53DeleteARecordBatch(domain, ip)}\n`, "utf8");
  return file;
}

function pathsEqual(left: string, right: string): boolean {
  return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function normalizeComparablePath(value: string): string {
  const normalized = normalize(value).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
