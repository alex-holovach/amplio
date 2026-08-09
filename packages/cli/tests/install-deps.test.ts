import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ensureRuntimeDependencies } from "../src/utils/install-deps.js";

describe("ensureRuntimeDependencies", () => {
  it("prints manual instructions without package.json", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await ensureRuntimeDependencies({
      cwd,
      packageManager: "pnpm",
    });
    expect(result).toBe("manual");
    expect(log.mock.calls.flat().join("\n")).toContain("pnpm add @useamplio/amplio zod");
    log.mockRestore();
  });

  it("skips when deps already listed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: { "@useamplio/amplio": "0.1.0", zod: "3" },
      }),
    );
    const result = await ensureRuntimeDependencies({
      cwd,
      packageManager: "npm",
    });
    expect(result).toBe("present");
  });

  it("skipInstall prints command for missing deps", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", dependencies: {} }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await ensureRuntimeDependencies({
      cwd,
      packageManager: "npm",
      skipInstall: true,
    });
    expect(result).toBe("skipped");
    expect(log.mock.calls.flat().join("\n")).toContain(
      "npm install @useamplio/amplio zod --no-audit --no-fund",
    );
    log.mockRestore();
    // package.json unchanged
    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({});
  });

  it("withCliDevDependency prints a devDependency install command on skipInstall", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: { "@useamplio/amplio": "0.1.0", zod: "3" },
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await ensureRuntimeDependencies({
      cwd,
      packageManager: "npm",
      skipInstall: true,
      withCliDevDependency: true,
    });
    expect(result).toBe("skipped");
    expect(log.mock.calls.flat().join("\n")).toContain(
      "npm install -D @useamplio/cli --no-audit --no-fund",
    );
    log.mockRestore();
  });

  it("withCliDevDependency is satisfied when the CLI is already a devDependency", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: { "@useamplio/amplio": "0.1.0", zod: "3" },
        devDependencies: { "@useamplio/cli": "0.1.0" },
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await ensureRuntimeDependencies({
      cwd,
      packageManager: "pnpm",
      withCliDevDependency: true,
    });
    expect(result).toBe("present");
    log.mockRestore();
  });
});
