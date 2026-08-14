import { access, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installRegistryItem,
  installRegistryItems,
} from "../src/registry/install.js";
import type { RegistryItem } from "../src/registry/types.js";

const exists = (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

function registryItem(
  files: Array<{ target: string; content: string }>,
): RegistryItem {
  return {
    name: "hostile-item",
    type: "registry:lib",
    files: files.map((file, index) => ({
      path: `registry/hostile-${index}.ts`,
      type: "registry:lib",
      ...file,
    })),
  };
}

describe("registry install target containment", () => {
  it("rejects traversal in any target before writing an earlier valid file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-target-"));
    const cwd = path.join(root, "app");
    await mkdir(cwd);
    const safePath = path.join(cwd, "telemetry/safe.ts");
    const escapedPath = path.join(root, "escaped.ts");

    await expect(
      installRegistryItem(
        registryItem([
          { target: "safe.ts", content: "export const safe = true;\n" },
          {
            target: "../../escaped.ts",
            content: "export const escaped = true;\n",
          },
        ]),
        {
          cwd,
          registryPath: path.join(cwd, "registry.json"),
        },
      ),
    ).rejects.toThrow(/target.*escapes the project root.*no files/i);

    expect(await exists(safePath)).toBe(false);
    expect(await exists(escapedPath)).toBe(false);
  });

  it("preflights every registry dependency before writing an earlier item", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-closure-"));
    const cwd = path.join(root, "app");
    await mkdir(cwd);
    const safePath = path.join(cwd, "telemetry/safe.ts");

    await expect(
      installRegistryItems(
        [
          registryItem([
            { target: "safe.ts", content: "export const safe = true;\n" },
          ]),
          registryItem([
            {
              target: "../../escaped.ts",
              content: "export const escaped = true;\n",
            },
          ]),
        ],
        {
          cwd,
          registryPath: path.join(cwd, "registry.json"),
        },
      ),
    ).rejects.toThrow(/target.*escapes the project root.*no files/i);

    expect(await exists(safePath)).toBe(false);
    expect(await exists(path.join(root, "escaped.ts"))).toBe(false);
  });

  it("rejects an existing target ancestor symlink that escapes the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-symlink-"));
    const cwd = path.join(root, "app");
    const outside = path.join(root, "outside");
    await mkdir(path.join(cwd, "telemetry"), { recursive: true });
    await mkdir(outside);
    await symlink(outside, path.join(cwd, "telemetry/plugins"), "dir");
    const outsidePath = path.join(outside, "escape.ts");

    await expect(
      installRegistryItem(
        registryItem([
          {
            target: "plugins/escape.ts",
            content: "export const escaped = true;\n",
          },
        ]),
        {
          cwd,
          registryPath: path.join(cwd, "registry.json"),
        },
      ),
    ).rejects.toThrow(/target.*symlink.*outside the project root.*no files/i);

    expect(await exists(outsidePath)).toBe(false);
  });

  it("allows an existing target ancestor symlink that remains in the project", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "amplio-registry-symlink-"));
    const cwd = path.join(root, "app");
    const storage = path.join(cwd, "generated/plugins");
    await mkdir(path.join(cwd, "telemetry"), { recursive: true });
    await mkdir(storage, { recursive: true });
    await symlink(storage, path.join(cwd, "telemetry/plugins"), "dir");

    await expect(
      installRegistryItem(
        registryItem([
          {
            target: "plugins/inside.ts",
            content: "export const inside = true;\n",
          },
        ]),
        {
          cwd,
          registryPath: path.join(cwd, "registry.json"),
        },
      ),
    ).resolves.toMatchObject({
      created: [path.join(cwd, "telemetry/plugins/inside.ts")],
    });

    expect(await readFile(path.join(storage, "inside.ts"), "utf8")).toBe(
      "export const inside = true;\n",
    );
  });
});
