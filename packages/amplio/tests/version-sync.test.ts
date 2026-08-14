import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type PackageJson = {
  name: string;
  version: string;
  packageManager?: string;
  engines?: { node?: string };
};

type RegistryManifest = {
  items: Array<{
    name: string;
    kind: string;
    coreRange?: string;
  }>;
};

type RegistryItem = {
  name: string;
  dependencies?: string[];
};

const VNEXT_MINIMUM_ALPHA = 16;

function readPackageJson(relativePath: string): PackageJson {
  const pkgPath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
}

describe("version sync", () => {
  it("root, @useamplio/amplio, and @useamplio/cli share the same version", () => {
    const root = readPackageJson("package.json");
    const core = readPackageJson("packages/amplio/package.json");
    const cli = readPackageJson("packages/cli/package.json");

    expect(root.name).toBe("amplio-monorepo");
    expect(core.name).toBe("@useamplio/amplio");
    expect(cli.name).toBe("@useamplio/cli");

    expect(typeof root.version).toBe("string");
    expect(root.version.length).toBeGreaterThan(0);

    expect(core.version).toBe(root.version);
    expect(cli.version).toBe(root.version);
  });

  it("reserves the Event and Plugin vNext release for alpha.16 or newer", () => {
    const { version } = readPackageJson("package.json");
    const match = /^0\.1\.0-alpha\.(\d+)$/.exec(version);

    expect(match, `unexpected alpha version ${version}`).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(VNEXT_MINIMUM_ALPHA);
  });

  it("pins every Plugin and generated registry artifact to this release", () => {
    const { version } = readPackageJson("package.json");
    const manifest = JSON.parse(
      readFileSync(
        path.join(repoRoot, "registry/registry.manifest.json"),
        "utf8",
      ),
    ) as RegistryManifest;
    const registries = [
      "registry/registry.json",
      "packages/cli/registry/registry.json",
    ].map((relativePath) => ({
      relativePath,
      value: JSON.parse(
        readFileSync(path.join(repoRoot, relativePath), "utf8"),
      ) as { items: RegistryItem[] },
    }));

    for (const item of manifest.items.filter(({ kind }) => kind === "plugin")) {
      expect(item.coreRange, item.name).toBe(`>=${version} <1`);
    }

    for (const { relativePath, value: registry } of registries) {
      for (const item of registry.items) {
        expect(item.dependencies, `${relativePath}/${item.name}`).toContain(
          `@useamplio/amplio@^${version}`,
        );
      }
    }

    for (const item of registries[0]!.value.items) {
      for (const generatedRoot of ["public/r", "apps/www/public/r"]) {
        const generated = JSON.parse(
          readFileSync(
            path.join(repoRoot, generatedRoot, `${item.name}.json`),
            "utf8",
          ),
        ) as RegistryItem;
        expect(
          generated.dependencies,
          `${generatedRoot}/${item.name}`,
        ).toContain(`@useamplio/amplio@^${version}`);
      }
    }
  });

  it("root package.json pins engines.node and packageManager", () => {
    const root = readPackageJson("package.json");
    expect(root.engines?.node).toBe(">=20");
    expect(root.packageManager).toBe("pnpm@9.15.0");
  });
});
