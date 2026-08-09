import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type PackageJson = {
  name: string;
  license?: string;
  private?: boolean;
  homepage?: string;
  bugs?: { url?: string };
  repository?: { url?: string; directory?: string };
};

function readPackageJson(relativePath: string): PackageJson {
  const pkgPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

function expectPublishMeta(pkg: PackageJson, name: string, directory: string): void {
  expect(pkg.name).toBe(name);
  expect(pkg.license).toBe("MIT");
  expect(pkg.homepage).toBe("https://github.com/alex-holovach/amplio#readme");
  expect(pkg.bugs?.url).toBe("https://github.com/alex-holovach/amplio/issues");
  expect(pkg.repository?.url).toBe("https://github.com/alex-holovach/amplio.git");
  expect(pkg.repository?.directory).toBe(directory);
}

describe("repository metadata", () => {
  it("@useamplio/amplio has repository, license, homepage, and bugs.url", () => {
    expectPublishMeta(readPackageJson("packages/amplio/package.json"), "@useamplio/amplio", "packages/amplio");
  });

  it("@useamplio/cli has repository, license, homepage, and bugs.url", () => {
    expectPublishMeta(readPackageJson("packages/cli/package.json"), "@useamplio/cli", "packages/cli");
  });

  it("root package.json declares MIT license and LICENSE file matches", () => {
    expect(readPackageJson("package.json").license).toBe("MIT");
    const licenseText = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
    expect(licenseText.startsWith("MIT License")).toBe(true);
  });

  it('root package.json has "private": true', () => {
    expect(readPackageJson("package.json").private).toBe(true);
  });
});
