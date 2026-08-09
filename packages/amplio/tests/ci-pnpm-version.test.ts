import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("ci pnpm version", () => {
  it("matches pnpm/action-setup version in ci.yml with root packageManager", () => {
    const ciYaml = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const root = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager?: string;
    };

    const versionMatch = ciYaml.match(/^\s*version:\s*([0-9][^\s]+)\s*$/m);
    expect(versionMatch, "ci.yml must set pnpm/action-setup version:").not.toBeNull();

    const ciPnpmVersion = versionMatch![1];
    expect(root.packageManager, "root package.json must set packageManager").toBeDefined();

    const packageManagerMatch = root.packageManager!.match(/^pnpm@(.+)$/);
    expect(packageManagerMatch, "packageManager must be pnpm@<version>").not.toBeNull();

    const packageJsonPnpmVersion = packageManagerMatch![1];
    expect(ciPnpmVersion).toBe(packageJsonPnpmVersion);
  });
});
