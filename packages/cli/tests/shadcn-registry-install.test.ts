import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

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

/** Mimics shadcn's root-anchored target install for registry:lib items. */
async function installShadcnItem(
  cwd: string,
  item: RegistryItem,
): Promise<string[]> {
  const written: string[] = [];

  for (const file of item.files) {
    if (!file.content) {
      throw new Error(
        `Registry item ${item.name} missing embedded content for ${file.path}`,
      );
    }
    if (!file.target?.startsWith("~/telemetry/")) {
      throw new Error(`Expected ~/telemetry/ target, got ${file.target}`);
    }

    const destination = path.join(cwd, file.target.slice(2));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, "utf8");
    written.push(path.relative(cwd, destination));
  }

  return written;
}

describe("shadcn-compatible vNext registry install", () => {
  beforeAll(() => {
    execFileSync("node", ["scripts/build-registry.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });
  });

  it("installs the HTTP root Event into telemetry/events only", async () => {
    const item = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/event-http-request.json"),
        "utf8",
      ),
    ) as RegistryItem;

    expect(item.name).toBe("event-http-request");
    expect(item.type).toBe("registry:lib");

    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-shadcn-"));
    const written = await installShadcnItem(cwd, item);

    expect(written).toEqual(["telemetry/events/http-request.ts"]);
    await access(path.join(cwd, "telemetry/events/http-request.ts"));
    const source = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(source).toContain('id: "http.request"');
    expect(source).toContain("// amplio:plugin-imports");
    expect(source).toContain("// amplio:plugins");
    expect(source).not.toMatch(/defineFact|defineWorkload/);
  });

  it("installs the editable Resend Plugin into telemetry/plugins only", async () => {
    const item = JSON.parse(
      await readFile(
        path.join(repoRoot, "public/r/plugin-resend.json"),
        "utf8",
      ),
    ) as RegistryItem;

    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-shadcn-"));
    const written = await installShadcnItem(cwd, item);

    expect(written).toEqual(["telemetry/plugins/resend.ts"]);
    const source = await readFile(
      path.join(cwd, "telemetry/plugins/resend.ts"),
      "utf8",
    );
    expect(source).toContain("export const ResendPlugin");
    expect(source).toContain('id: "resend.send"');
    expect(source).not.toMatch(/address|subject|body|api.?key|query/i);
  });

  it("indexes only current semantic and operational item names", async () => {
    const registry = JSON.parse(
      await readFile(path.join(repoRoot, "public/r/registry.json"), "utf8"),
    ) as { items: Array<{ name: string }> };
    const names = registry.items.map((item) => item.name);

    expect(names).toContain("event-http-request");
    expect(names).toContain("plugin-resend");
    expect(
      names.some((name) =>
        /^(component|workload|middleware|integration)-/.test(name),
      ),
    ).toBe(false);
  });
});
