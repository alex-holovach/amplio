import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { minVersion, Range } from "semver";
import { describe, expect, it, vi } from "vitest";
import type { RegistryItem } from "../src/registry/types.js";
import { ensurePluginProviderDependency } from "../src/utils/provider-dependency.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type ManifestPlugin = Omit<RegistryItem, "files" | "type"> & {
  kind: "plugin";
  providerRanges: Record<string, string>;
};

const manifest = JSON.parse(
  await readFile(
    path.join(repoRoot, "registry/registry.manifest.json"),
    "utf8",
  ),
) as { items: Array<ManifestPlugin | { kind: string }> };

const plugins = manifest.items.filter(
  (item): item is ManifestPlugin => item.kind === "plugin",
);

function upperBoundary(range: string): string {
  const boundaries = new Range(range).set.flatMap((comparators) =>
    comparators
      .filter((comparator) => comparator.operator === "<")
      .map((comparator) => comparator.semver.version),
  );
  if (boundaries.length !== 1) {
    throw new Error(`${range} must have one exclusive upper boundary`);
  }
  return boundaries[0]!;
}

const rejectionCases = plugins.flatMap((plugin) => {
  const [provider, range] = Object.entries(plugin.providerRanges)[0]!;
  const minimum = minVersion(range)?.version;
  if (!minimum) {
    throw new Error(`${range} must have a minimum satisfying version`);
  }
  const upper = upperBoundary(range);
  return [
    {
      boundary: "excluded minimum prerelease",
      plugin,
      provider,
      range,
      spec: `${minimum}-0`,
    },
    { boundary: "excluded stable upper", plugin, provider, range, spec: upper },
    {
      boundary: "excluded upper prerelease",
      plugin,
      provider,
      range,
      spec: `${upper}-0`,
    },
  ];
});

describe("Plugin provider boundary preflight", () => {
  it.each(rejectionCases)(
    "rejects $plugin.name $boundary before package or Plugin writes",
    async ({ plugin, provider, range, spec }) => {
      const cwd = await mkdtemp(
        path.join(tmpdir(), "amplio-provider-boundary-"),
      );
      const packagePath = path.join(cwd, "package.json");
      const pluginPath = path.join(
        cwd,
        "telemetry/plugins",
        `${plugin.name.replace(/^plugin-/, "")}.ts`,
      );
      await mkdir(path.dirname(pluginPath), { recursive: true });
      await writeFile(
        packagePath,
        `${JSON.stringify(
          {
            name: "provider-boundary-fixture",
            private: true,
            dependencies: {
              "@useamplio/amplio": "0.1.0-alpha.16",
              [provider]: spec,
              zod: "^3.24.2",
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(pluginPath, "// customer sentinel\n");
      const beforePackage = await readFile(packagePath, "utf8");
      const beforePlugin = await readFile(pluginPath, "utf8");
      const install = vi.fn(async () => ({ ok: true, output: "" }));

      await expect(
        ensurePluginProviderDependency({
          cwd,
          item: { ...plugin, type: "registry:lib", files: [] },
          packageManager: "pnpm",
          yes: true,
          install,
        }),
      ).rejects.toThrow(new RegExp(`outside supported range "${range}"`));

      expect(install).not.toHaveBeenCalled();
      await expect(readFile(packagePath, "utf8")).resolves.toBe(beforePackage);
      await expect(readFile(pluginPath, "utf8")).resolves.toBe(beforePlugin);
      await expect(access(path.join(cwd, ".amplio"))).rejects.toThrow();
    },
  );
});
