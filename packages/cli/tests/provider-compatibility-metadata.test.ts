import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  compare,
  minVersion,
  prerelease,
  Range,
  satisfies,
  valid,
} from "semver";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type TestedProviderVersions = Record<
  string,
  { minimum: string; latest: string }
>;

type PluginManifestItem = {
  name: string;
  kind: "plugin";
  providerRanges: Record<string, string>;
  testedProviderVersions?: TestedProviderVersions;
};

async function readPluginItems(): Promise<PluginManifestItem[]> {
  const manifest = JSON.parse(
    await readFile(
      path.join(repoRoot, "registry/registry.manifest.json"),
      "utf8",
    ),
  ) as { items: Array<PluginManifestItem | { kind: string }> };

  return manifest.items.filter(
    (item): item is PluginManifestItem => item.kind === "plugin",
  );
}

function exclusiveUpperBoundary(range: string): string {
  const upperBounds = new Range(range).set.flatMap((comparators) =>
    comparators
      .filter((comparator) => comparator.operator === "<")
      .map((comparator) => comparator.semver.version),
  );
  expect(upperBounds, `${range} exclusive upper boundary`).toHaveLength(1);
  return upperBounds[0]!;
}

describe("registry Plugin provider compatibility metadata", () => {
  it("declares exact minimum and latest tested provider versions for every Plugin", async () => {
    const plugins = await readPluginItems();
    expect(plugins).toHaveLength(8);

    for (const plugin of plugins) {
      const ranges = Object.entries(plugin.providerRanges);
      const tested = Object.entries(plugin.testedProviderVersions ?? {});
      expect(ranges, `${plugin.name} provider range`).toHaveLength(1);
      expect(tested, `${plugin.name} tested provider versions`).toHaveLength(1);

      const [provider, range] = ranges[0]!;
      const [testedProvider, versions] = tested[0]!;
      expect(testedProvider, `${plugin.name} tested provider package`).toBe(
        provider,
      );

      const minimum = minVersion(range)?.version;
      expect(versions.minimum, `${plugin.name} minimum`).toBe(minimum);
      expect(valid(versions.latest), `${plugin.name} latest SemVer`).toBe(
        versions.latest,
      );
      expect(
        prerelease(versions.minimum),
        `${plugin.name} minimum stable`,
      ).toBe(null);
      expect(prerelease(versions.latest), `${plugin.name} latest stable`).toBe(
        null,
      );
      expect(
        satisfies(versions.minimum, range),
        `${plugin.name} minimum satisfies ${range}`,
      ).toBe(true);
      expect(
        satisfies(versions.latest, range),
        `${plugin.name} latest satisfies ${range}`,
      ).toBe(true);
      expect(
        compare(versions.minimum, versions.latest),
        `${plugin.name} minimum <= latest`,
      ).toBeLessThanOrEqual(0);
    }
  });

  it("rejects the excluded stable upper and prerelease boundaries", async () => {
    for (const plugin of await readPluginItems()) {
      const [, range] = Object.entries(plugin.providerRanges)[0]!;
      const minimum = minVersion(range)!.version;
      const upper = exclusiveUpperBoundary(range);

      expect(satisfies(upper, range), `${plugin.name} excluded upper`).toBe(
        false,
      );
      expect(
        satisfies(`${minimum}-0`, range),
        `${plugin.name} minimum prerelease`,
      ).toBe(false);
      expect(
        satisfies(`${upper}-0`, range),
        `${plugin.name} upper prerelease`,
      ).toBe(false);
    }
  });

  it("publishes the tested versions in generated Plugin metadata", async () => {
    for (const plugin of await readPluginItems()) {
      const generated = JSON.parse(
        await readFile(
          path.join(repoRoot, "public/r", `${plugin.name}.json`),
          "utf8",
        ),
      ) as {
        meta?: {
          amplio?: { testedProviderVersions?: TestedProviderVersions };
        };
      };

      expect(
        generated.meta?.amplio?.testedProviderVersions,
        `${plugin.name} generated metadata`,
      ).toEqual(plugin.testedProviderVersions);
    }
  });

  it("derives the executable minimum/latest matrix from the manifest", async () => {
    const output = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "packages/cli/scripts/provider-compatibility.mjs"),
        "matrix",
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const matrix = JSON.parse(output) as {
      include: Array<{
        plugin: string;
        provider: string;
        slot: "minimum" | "latest";
        version: string;
      }>;
    };

    expect(matrix.include).toHaveLength(16);
    for (const plugin of await readPluginItems()) {
      const [provider, versions] = Object.entries(
        plugin.testedProviderVersions!,
      )[0]!;
      expect(
        matrix.include.filter((entry) => entry.plugin === plugin.name),
      ).toEqual([
        {
          plugin: plugin.name,
          provider,
          slot: "minimum",
          version: versions.minimum,
        },
        {
          plugin: plugin.name,
          provider,
          slot: "latest",
          version: versions.latest,
        },
      ]);
    }
  });
});
import { execFileSync } from "node:child_process";
