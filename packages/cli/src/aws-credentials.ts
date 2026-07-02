import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultRunner, type CommandRunner } from "./connect.js";

export interface AwsCredentialInput {
  csvFile: string;
  profile?: string;
  region?: string;
  homeDir?: string;
  runner?: CommandRunner;
}

export interface AwsVerifyInput {
  profile?: string;
  runner?: CommandRunner;
}

export interface AwsIdentityReport {
  ok: true;
  profile: string;
  region?: string;
  root: boolean;
  arn: string;
  credentials_file?: string;
  config_file?: string;
}

export function onboardAws(): any {
  return {
    ok: true,
    purpose: "Prepare AWS account, credentials, DNS authority, and billing guardrails before deploy.",
    paths: [
      {
        id: "root-access-key",
        label: "Root access key",
        summary: "Fastest first deployment path, but highly privileged.",
        guidance: [
          "Create an AWS account or sign in as the account owner.",
          "Create an access key CSV only if you explicitly choose the root-key path.",
          "Save the CSV securely, never paste it into chat, and rotate or delete the key after deployment."
        ]
      },
      {
        id: "dedicated-iam-user",
        label: "Dedicated IAM deployment user",
        summary: "Safer path that avoids root keys.",
        guidance: [
          "Create a temporary IAM user named DirexioDeployer.",
          "Attach AdministratorAccess for the deployment window.",
          "Create an access key CSV, deploy, then delete or disable the user or reduce its policy."
        ]
      }
    ],
    next_commands: [
      "direxio aws import-csv <aws-access-key.csv> --profile direxio-deployer --region <aws-region>",
      "direxio aws verify --profile direxio-deployer",
      "direxio deploy --service <service-id> --domain <domain> --region <aws-region> --dns auto --agent-install auto --confirm-domain"
    ],
    billing: [
      "Check AWS Billing Console credits and Free Tier state before deploy.",
      "Set an AWS Budget or billing alert before leaving the node running.",
      "Lightsail instances/static IPs, EC2, EBS, public IPv4, Elastic IP, and Route53 hosted zones can bill until destroy completes."
    ]
  };
}

export async function importAwsCsvCredentials(input: AwsCredentialInput): Promise<AwsIdentityReport> {
  const profile = input.profile?.trim() || "direxio-deployer";
  const region = input.region?.trim() || process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || "us-east-1";
  const home = input.homeDir ?? homedir();
  const parsed = readAwsCsv(input.csvFile);
  const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
  const configFile = process.env.AWS_CONFIG_FILE || join(home, ".aws", "config");

  writeIniSection(credentialsFile, profileHeader(profile, false), [
    ["aws_access_key_id", parsed.accessKeyId],
    ["aws_secret_access_key", parsed.secretAccessKey],
    ...(parsed.sessionToken ? [["aws_session_token", parsed.sessionToken] as [string, string]] : [])
  ]);
  writeIniSection(configFile, profileHeader(profile, true), [
    ["region", region],
    ["output", "json"]
  ]);

  const identity = await verifyAwsProfile({ profile, runner: input.runner });
  return {
    ...identity,
    region,
    credentials_file: credentialsFile,
    config_file: configFile
  };
}

export async function verifyAwsProfile(input: AwsVerifyInput = {}): Promise<AwsIdentityReport> {
  const profile = input.profile?.trim() || process.env.AWS_PROFILE || "direxio-deployer";
  const runner = input.runner ?? defaultRunner;
  const result = await runner("aws", ["--profile", profile, "sts", "get-caller-identity"]);
  if (result.exitCode !== 0) {
    throw new Error((result.stderr || result.stdout || `aws exited with ${result.exitCode}`).trim());
  }
  const payload = JSON.parse(result.stdout || "{}") as { Arn?: string };
  const arn = String(payload.Arn || "");
  if (!arn) throw new Error(`AWS profile could not be verified with sts get-caller-identity: ${profile}`);
  return {
    ok: true,
    profile,
    root: arn.endsWith(":root"),
    arn: redactAwsArn(arn)
  };
}

function readAwsCsv(csvFile: string): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  if (!existsSync(csvFile)) throw new Error(`CSV file not found: ${csvFile}`);
  const lines = readFileSync(csvFile, "utf8").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) throw new Error(`CSV has no credential row: ${csvFile}`);
  const headers = parseCsvLine(lines[0]).map((header) => header.replace(/^\uFEFF/, "").trim().toLowerCase());
  const values = parseCsvLine(lines[1]).map((value) => value.trim());
  const accessKeyId = values[columnIndex(headers, "access key id")] || "";
  const secretAccessKey = values[columnIndex(headers, "secret access key")] || "";
  const sessionIndex = headers.indexOf("session token");
  const sessionToken = sessionIndex >= 0 ? values[sessionIndex] || "" : "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("CSV must contain Access key ID and Secret access key columns with values");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && line[index + 1] === '"') {
      current += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values.map((value) => value.replace(/^"|"$/g, "").trim());
}

function columnIndex(headers: string[], name: string): number {
  const index = headers.indexOf(name);
  if (index < 0) throw new Error(`CSV must contain ${name} column`);
  return index;
}

function writeIniSection(file: string, header: string, values: Array<[string, string]>): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const filtered = removeIniSection(existing, header);
  const body = [
    filtered.trimEnd(),
    `[${header}]`,
    ...values.map(([key, value]) => `${key} = ${value}`),
    ""
  ].filter((part, index) => index !== 0 || part.length > 0).join("\n");
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${body}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
}

function removeIniSection(text: string, header: string): string {
  const target = `[${header}]`;
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (/^\[[^\]]+\]\s*$/.test(line)) skip = line.trim() === target;
    if (!skip) kept.push(line);
  }
  return kept.join("\n");
}

function profileHeader(profile: string, config: boolean): string {
  return config && profile !== "default" ? `profile ${profile}` : profile;
}

function redactAwsArn(arn: string): string {
  return arn.replace(/arn:aws:iam::\d{12}:/, "arn:aws:iam::<account>:");
}
