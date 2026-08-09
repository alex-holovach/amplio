import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mergePackageDependencies } from "../src/registry/install.js";

async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

describe("mergePackageDependencies", () => {
  it("skips deps already present in either section", async () => {
    const cwd = await makeTempDir("amplio-merge-skip-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: { next: "^15.0.0" },
        devDependencies: {},
      }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const changed = await mergePackageDependencies(cwd, ["next"], ["next"]);
    expect(changed).toBe(false);
    log.mockRestore();

    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    expect(pkg.dependencies.next).toBe("^15.0.0");
    expect(pkg.devDependencies).toEqual({});
  });

  it("pins @useamplio/amplio and zod when version omitted", async () => {
    const cwd = await makeTempDir("amplio-merge-pin-");
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({ name: "x", dependencies: {}, devDependencies: {} }),
    );

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const changed = await mergePackageDependencies(cwd, ["@useamplio/amplio", "zod"], []);
    expect(changed).toBe(true);
    log.mockRestore();

    const pkg = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    expect(pkg.dependencies["@useamplio/amplio"]).toMatch(/^\^/);
    expect(pkg.dependencies["@useamplio/amplio"]).not.toBe("*");
    expect(pkg.dependencies.zod).toBe("^3.24.0 || ^4.0.0");
  });

  it("does not rewrite package.json when nothing changed", async () => {
    const cwd = await makeTempDir("amplio-merge-noop-");
    const before = JSON.stringify({ name: "x", dependencies: { hono: "^4" } }, null, 2) + "\n";
    await writeFile(path.join(cwd, "package.json"), before);

    const changed = await mergePackageDependencies(cwd, ["hono"], []);
    expect(changed).toBe(false);
    expect(await readFile(path.join(cwd, "package.json"), "utf8")).toBe(before);
  });
});
