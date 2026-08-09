import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { describe, expect, it } from "vitest";
import { runInit } from "../src/commands/init.js";
import { runAddEvent } from "../src/commands/add.js";
import { renderEventTemplate } from "../src/templates/event.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const registryEvents = path.join(repoRoot, "registry/events");

async function assertPrettier(source: string, label: string): Promise<void> {
  const formatted = await prettier.format(source, {
    parser: "typescript",
    // Prettier defaults (explicit for stability)
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    printWidth: 80,
    tabWidth: 2,
  });
  expect(source, label).toBe(formatted);
}

async function walkTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkTsFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("generated event prettier defaults", () => {
  it("event template output matches Prettier defaults", async () => {
    const source = renderEventTemplate("billing.invoice.paid");
    await assertPrettier(source, "renderEventTemplate(billing.invoice.paid)");
  });

  it("registry event sources match Prettier defaults", async () => {
    const files = await walkTsFiles(registryEvents);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      await assertPrettier(source, path.relative(repoRoot, file));
    }
  });

  it("amplio add event output matches Prettier defaults", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-prettier-"));
    await runInit({ cwd, service: "prettier-app" , skipInstall: true });
    await runAddEvent("ops.deploy.started", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/ops/deploy-started.ts");
    const source = await readFile(eventPath, "utf8");
    await assertPrettier(source, eventPath);
  });
});
