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
  it("@amplio/core has publishConfig.access === \"public\"", () => {
    const pkg = readPackageJson("packages/core/package.json");
    expect(pkg.name).toBe("@amplio/core");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("@amplio/cli has publishConfig.access === \"public\"", () => {
    const pkg = readPackageJson("packages/cli/package.json");
    expect(pkg.name).toBe("@amplio/cli");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("@amplio/core and @amplio/cli require Node >=20", () => {
    const core = readPackageJson("packages/core/package.json");
    const cli = readPackageJson("packages/cli/package.json");
    expect(core.name).toBe("@amplio/core");
    expect(cli.name).toBe("@amplio/cli");
    expect(core.engines?.node).toBe(">=20");
    expect(cli.engines?.node).toBe(">=20");
  });

  it('@amplio/core peerDependencies.zod === "^3.0.0 || ^4.0.0"', () => {
    const pkg = readPackageJson("packages/core/package.json");
    expect(pkg.name).toBe("@amplio/core");
    expect(pkg.peerDependencies?.zod).toBe("^3.0.0 || ^4.0.0");
  });

  it("@amplio/core peerDependenciesMeta.zod.optional === true", () => {
    const pkg = readPackageJson("packages/core/package.json");
    expect(pkg.name).toBe("@amplio/core");
    expect(pkg.peerDependenciesMeta?.zod?.optional).toBe(true);
  });
});
