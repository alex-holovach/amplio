import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runAddPlugin } from "../src/commands/add.js";
import { runInit } from "../src/commands/init.js";
import type { RegistryItem } from "../src/registry/types.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const registryPath = path.join(repoRoot, "registry/registry.manifest.json");
const manifest = JSON.parse(await readFile(registryPath, "utf8")) as {
  items: RegistryItem[];
};
const plugins = manifest.items.filter(
  (item): item is RegistryItem & { kind: "plugin" } => item.kind === "plugin",
);

async function snapshotFiles(
  root: string,
  directory = root,
): Promise<Record<string, string>> {
  const files: Array<[string, string]> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...Object.entries(await snapshotFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push([
        path.relative(root, absolute).replace(/\\/g, "/"),
        await readFile(absolute, "utf8"),
      ]);
    }
  }
  return Object.fromEntries(
    files.sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function makeCompatibleProject(item: RegistryItem): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-plugin-idempotence-"));
  const [provider, versions] = Object.entries(
    item.testedProviderVersions ?? {},
  )[0] ?? [undefined, undefined];
  if (!provider || !versions) {
    throw new Error(`${item.name} is missing tested provider versions`);
  }
  await mkdir(cwd, { recursive: true });
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: `${item.name}-idempotence`,
        private: true,
        type: "module",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.17",
          [provider]: versions.minimum,
          zod: "^3.24.2",
        },
        devDependencies: { "@types/express": "^5.0.0" },
      },
      null,
      2,
    )}\n`,
  );
  await runInit({ cwd, skipInstall: true });
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = registryPath;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return cwd;
}

describe("universal Plugin installation contract", () => {
  it.each(plugins)(
    "$name source installation is byte-for-byte idempotent",
    async (item) => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      try {
        const cwd = await makeCompatibleProject(item);
        const slug = item.name.replace(/^plugin-/, "");
        const options = {
          cwd,
          sourceOnly: true,
          ...(item.role === "contributor" ? { event: "http.request" } : {}),
        };

        await runAddPlugin(slug, options);
        const installed = await snapshotFiles(cwd);
        await runAddPlugin(slug, options);

        await expect(snapshotFiles(cwd)).resolves.toEqual(installed);
      } finally {
        log.mockRestore();
      }
    },
  );
});
