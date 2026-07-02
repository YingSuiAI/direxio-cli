import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { importAwsCsvCredentials, onboardAws, verifyAwsProfile } from "../src/aws-credentials.js";

describe("AWS credentials onboarding", () => {
  it("imports AWS CSV credentials into a profile without printing secrets", async () => {
    const home = mkdtempSync(join(tmpdir(), "direxio-cli-aws-creds-"));
    const csv = join(home, "accessKeys.csv");
    writeFileSync(csv, "User name,Access key ID,Secret access key\nDirexioDeployer,AKIADIREXIO,SECRET_DIREXIO\n", "utf8");
    const calls: Array<{ command: string; args: string[] }> = [];

    const report = await importAwsCsvCredentials({
      csvFile: csv,
      profile: "direxio-deployer",
      region: "ap-southeast-1",
      homeDir: home,
      runner: async (command, args) => {
        calls.push({ command, args });
        return {
          stdout: JSON.stringify({
            Account: "123456789012",
            Arn: "arn:aws:iam::123456789012:user/DirexioDeployer"
          }),
          stderr: "",
          exitCode: 0
        };
      }
    });

    expect(report).toMatchObject({
      ok: true,
      profile: "direxio-deployer",
      region: "ap-southeast-1",
      root: false,
      arn: "arn:aws:iam::<account>:user/DirexioDeployer"
    });
    expect(JSON.stringify(report)).not.toContain("AKIADIREXIO");
    expect(JSON.stringify(report)).not.toContain("SECRET_DIREXIO");
    expect(readFileSync(join(home, ".aws", "credentials"), "utf8")).toContain("aws_access_key_id = AKIADIREXIO");
    expect(readFileSync(join(home, ".aws", "config"), "utf8")).toContain("region = ap-southeast-1");
    expect(calls).toEqual([
      { command: "aws", args: ["--profile", "direxio-deployer", "sts", "get-caller-identity"] }
    ]);
  });

  it("detects root AWS profiles during verification", async () => {
    await expect(
      verifyAwsProfile({
        profile: "root-profile",
        runner: async () => ({
          stdout: JSON.stringify({
            Account: "123456789012",
            Arn: "arn:aws:iam::123456789012:root"
          }),
          stderr: "",
          exitCode: 0
        })
      })
    ).resolves.toMatchObject({
      ok: true,
      profile: "root-profile",
      root: true,
      arn: "arn:aws:iam::<account>:root"
    });
  });

  it("describes the first-time AWS setup paths", () => {
    expect(onboardAws()).toMatchObject({
      ok: true,
      paths: expect.arrayContaining([
        expect.objectContaining({ id: "root-access-key" }),
        expect.objectContaining({ id: "dedicated-iam-user" })
      ])
    });
  });
});
