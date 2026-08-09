import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type PackageJson = {
  name: string;
  version: string;
  packageManager?: string;
  engines?: { node?: string };
};

function readPackageJson(relativePath: string): PackageJson {
  const pkgPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

describe("version sync", () => {
  it("root, @amplio/amplio, and @amplio/cli share the same version", () => {
    const root = readPackageJson("package.json");
    const core = readPackageJson("packages/amplio/package.json");
    const cli = readPackageJson("packages/cli/package.json");

    expect(root.name).toBe("amplio");
    expect(core.name).toBe("@amplio/amplio");
    expect(cli.name).toBe("@amplio/cli");

    expect(typeof root.version).toBe("string");
    expect(root.version.length).toBeGreaterThan(0);

    expect(core.version).toBe(root.version);
    expect(cli.version).toBe(root.version);
  });

  it("root package.json pins engines.node and packageManager", () => {
    const root = readPackageJson("package.json");
    expect(root.engines?.node).toBe(">=20");
    expect(root.packageManager).toBe("pnpm@9.15.0");
  });
});
