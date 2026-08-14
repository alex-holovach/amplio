import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRegistry,
  readRegistryFileContent,
} from "../src/registry/resolve.js";

async function writeManifest(
  registryRoot: string,
  source: string,
): Promise<string> {
  const manifestPath = path.join(registryRoot, "registry.manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "hostile-registry",
        items: [
          {
            name: "hostile",
            source,
            target: "telemetry/hostile.ts",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return manifestPath;
}

describe("registry source containment", () => {
  it("rejects manifest source traversal before reading outside the registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-source-"));
    const registryRoot = path.join(root, "registry");
    await mkdir(registryRoot);
    await writeFile(
      path.join(root, "secret.ts"),
      "export const secret = true;\n",
    );
    const manifestPath = await writeManifest(registryRoot, "../secret.ts");

    await expect(loadRegistry(manifestPath)).rejects.toThrow(
      /manifest source.*escapes the registry root.*no files/i,
    );
  });

  it("rejects a manifest source symlink that resolves outside the registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-source-"));
    const registryRoot = path.join(root, "registry");
    await mkdir(registryRoot);
    const secretPath = path.join(root, "secret.ts");
    await writeFile(secretPath, "export const secret = true;\n");
    await symlink(secretPath, path.join(registryRoot, "linked.ts"), "file");
    const manifestPath = await writeManifest(registryRoot, "linked.ts");

    await expect(loadRegistry(manifestPath)).rejects.toThrow(
      /manifest source.*symlink.*outside the registry root.*no files/i,
    );
  });

  it("rejects compiled file.path traversal even when content is embedded", async () => {
    const registryRoot = await mkdtemp(
      path.join(tmpdir(), "amplio-registry-file-"),
    );
    const registryPath = path.join(registryRoot, "registry.json");

    await expect(
      readRegistryFileContent(
        registryPath,
        "registry/../../secret.ts",
        "export const embedded = true;\n",
      ),
    ).rejects.toThrow(/registry file path.*escapes the registry root/i);
  });

  it("rejects a compiled file.path symlink outside the registry", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-file-"));
    const registryRoot = path.join(root, "registry");
    await mkdir(registryRoot);
    const secretPath = path.join(root, "secret.ts");
    await writeFile(secretPath, "export const secret = true;\n");
    await symlink(secretPath, path.join(registryRoot, "linked.ts"), "file");

    await expect(
      readRegistryFileContent(
        path.join(registryRoot, "registry.json"),
        "registry/linked.ts",
        "export const embedded = true;\n",
      ),
    ).rejects.toThrow(
      /registry file path.*symlink.*outside the registry root/i,
    );
  });

  it("accepts a normalized embedded file.path inside the registry root", async () => {
    const registryRoot = await mkdtemp(
      path.join(tmpdir(), "amplio-registry-file-"),
    );

    await expect(
      readRegistryFileContent(
        path.join(registryRoot, "registry.json"),
        "registry/plugins/example.ts",
        "export const example = true;\n",
      ),
    ).resolves.toBe("export const example = true;\n");
  });
});
