import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type PackageJson = {
  name: string;
  publishConfig?: { access?: string };
  engines?: { node?: string };
  peerDependencies?: { zod?: string };
  peerDependenciesMeta?: { zod?: { optional?: boolean } };
};

function readPackageJson(relativePath: string): PackageJson {
  const pkgPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

describe("publish config", () => {
  it("@useamplio/amplio has publishConfig.access === \"public\"", () => {
    const pkg = readPackageJson("packages/amplio/package.json");
    expect(pkg.name).toBe("@useamplio/amplio");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("@useamplio/cli has publishConfig.access === \"public\"", () => {
    const pkg = readPackageJson("packages/cli/package.json");
    expect(pkg.name).toBe("@useamplio/cli");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("@useamplio/amplio and @useamplio/cli require Node >=20", () => {
    const core = readPackageJson("packages/amplio/package.json");
    const cli = readPackageJson("packages/cli/package.json");
    expect(core.name).toBe("@useamplio/amplio");
    expect(cli.name).toBe("@useamplio/cli");
    expect(core.engines?.node).toBe(">=20");
    expect(cli.engines?.node).toBe(">=20");
  });

  it('@useamplio/amplio peerDependencies.zod === "^3.0.0 || ^4.0.0"', () => {
    const pkg = readPackageJson("packages/amplio/package.json");
    expect(pkg.name).toBe("@useamplio/amplio");
    expect(pkg.peerDependencies?.zod).toBe("^3.0.0 || ^4.0.0");
  });

  it("@useamplio/amplio peerDependenciesMeta.zod.optional === true", () => {
    const pkg = readPackageJson("packages/amplio/package.json");
    expect(pkg.name).toBe("@useamplio/amplio");
    expect(pkg.peerDependenciesMeta?.zod?.optional).toBe(true);
  });
});
