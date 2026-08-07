import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const REQUIRED_ITEMS = [
  "middleware-hono",
  "event-auth-user-signed-up",
  "sink-otlp",
  "integration-better-auth",
] as const;

describe("registry build", () => {
  it("builds public/r/registry.json with expected items and file content", async () => {
    execFileSync("node", ["scripts/build-registry.mjs"], {
      cwd: repoRoot,
      stdio: "pipe",
    });

    const registryPath = path.join(repoRoot, "public/r/registry.json");
    await access(registryPath);

    const registry = JSON.parse(await readFile(registryPath, "utf8"));
    expect(registry.$schema).toBe("https://ui.shadcn.com/schema/registry.json");
    const itemNames = registry.items.map((item: { name: string }) => item.name);

    for (const name of REQUIRED_ITEMS) {
      expect(itemNames).toContain(name);
    }

    for (const indexItem of registry.items) {
      expect(typeof indexItem.name).toBe("string");
      expect(indexItem.name.length).toBeGreaterThan(0);
      expect(typeof indexItem.type).toBe("string");
      expect(indexItem.type.length).toBeGreaterThan(0);
      expect(typeof indexItem.title).toBe("string");
      expect(indexItem.title.length).toBeGreaterThan(0);
      expect(typeof indexItem.description).toBe("string");
      expect(indexItem.description.length).toBeGreaterThan(0);
    }

    const itemPath = path.join(repoRoot, "public/r/middleware-hono.json");
    const item = JSON.parse(await readFile(itemPath, "utf8"));
    expect(item.files?.[0]?.content?.length).toBeGreaterThan(0);

    const middlewareIndex = registry.items.find(
      (entry: { name: string }) => entry.name === "middleware-hono",
    );
    expect(middlewareIndex).toBeDefined();
    expect(middlewareIndex.title).toBe("Hono Middleware");
    expect(middlewareIndex.description).toBe(item.description);

    const sinkConsoleIndex = registry.items.find(
      (entry: { name: string }) => entry.name === "sink-console",
    );
    expect(sinkConsoleIndex).toBeDefined();
    expect(sinkConsoleIndex.title).toBe("Console Sink");
  });
});
