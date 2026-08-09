import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type PackageJson = {
  name: string;
  keywords?: string[];
};

function readPackageJson(relativePath: string): PackageJson {
  const pkgPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

describe("keywords metadata", () => {
  it("@useamplio/amplio keywords include telemetry and length >= 3", () => {
    const pkg = readPackageJson("packages/amplio/package.json");
    expect(pkg.name).toBe("@useamplio/amplio");
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords).toContain("telemetry");
    expect(pkg.keywords!.length).toBeGreaterThanOrEqual(3);
  });

  it("@useamplio/cli keywords include telemetry and length >= 3", () => {
    const pkg = readPackageJson("packages/cli/package.json");
    expect(pkg.name).toBe("@useamplio/cli");
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords).toContain("telemetry");
    expect(pkg.keywords!.length).toBeGreaterThanOrEqual(3);
  });
});
