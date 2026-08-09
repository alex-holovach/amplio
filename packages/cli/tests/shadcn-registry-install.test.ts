import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

type RegistryFile = {
  path: string;
  type: string;
  target?: string;
  content?: string;
};

type RegistryItem = {
  name: string;
  type: string;
  files: RegistryFile[];
};

/**
 * Mimic shadcn's local file install for `registry:lib` items:
 * target `telemetry/events/...` → `<cwd>/telemetry/events/...`
 */
async function installShadcnItem(cwd: string, item: RegistryItem): Promise<string[]> {
  const written: string[] = [];

  for (const file of item.files) {
    if (!file.content) {
      throw new Error(`Registry item ${item.name} missing embedded content for ${file.path}`);
    }
    if (!file.target?.startsWith("telemetry/")) {
      throw new Error(`Expected telemetry/ target, got ${file.target}`);
    }

    const dest = path.join(cwd, file.target);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.content, "utf8");
    written.push(path.relative(cwd, dest));
  }

  return written;
}

describe("shadcn-compatible registry install", () => {
  beforeAll(() => {
    execFileSync("node", ["scripts/build-registry.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  it("installs @useamplio/event-auth-user-signed-up into telemetry/ only", async () => {
    const itemPath = path.join(repoRoot, "public/r/event-auth-user-signed-up.json");
    const item = JSON.parse(await readFile(itemPath, "utf8")) as RegistryItem;

    expect(item.name).toBe("event-auth-user-signed-up");
    expect(item.type).toBe("registry:lib");
    expect(item.files.length).toBeGreaterThan(0);

    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-shadcn-"));
    const written = await installShadcnItem(cwd, item);

    expect(written).toEqual(["telemetry/events/auth/user-signed-up.ts"]);
    await access(path.join(cwd, "telemetry/events/auth/user-signed-up.ts"));

    const source = await readFile(
      path.join(cwd, "telemetry/events/auth/user-signed-up.ts"),
      "utf8",
    );
    expect(source).toContain("auth.user.signed_up");
    expect(source).toContain("AuthUserSignedUp");
    expect(source).toContain("defineEvent");

    // No files outside telemetry/
    for (const rel of written) {
      expect(rel.startsWith("telemetry/")).toBe(true);
    }
  });

  it("registry index lists the shadcn item name consumers would add", async () => {
    const registry = JSON.parse(
      await readFile(path.join(repoRoot, "public/r/registry.json"), "utf8"),
    ) as { items: Array<{ name: string }> };

    expect(registry.items.map((i) => i.name)).toContain("event-auth-user-signed-up");
  });
});
