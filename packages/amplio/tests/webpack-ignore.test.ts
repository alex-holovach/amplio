import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("next/server runtime probe", () => {
  it("source keeps the specifier out of static analysis with magic comments", () => {
    const source = readFileSync(path.join(pkgRoot, "src/schedule-flush.ts"), "utf8");
    expect(source).toContain("/* webpackIgnore: true */");
    expect(source).toContain("/* @vite-ignore */");
    // The specifier must stay a variable — a literal would make bundlers
    // resolve "next/server" statically and fail non-Next builds.
    expect(source).toMatch(/import\((?:\/\*[^*]*\*\/\s*)*nextServerSpec\)/);
  });

  it("dist keeps the webpackIgnore comment after minification", () => {
    const distPath = path.join(pkgRoot, "dist/index.js");
    if (!existsSync(distPath)) {
      // dist is produced by `pnpm build`; CI always builds before testing.
      return;
    }
    const dist = readFileSync(distPath, "utf8");
    // Without this, webpack prints "Critical dependency: the request of a
    // dependency is an expression" on every `next build` that imports the
    // runtime (see scripts/annotate-dynamic-import.mjs).
    expect(dist).toMatch(/import\(\/\* webpackIgnore: true \*\/ \/\* @vite-ignore \*\/ [A-Za-z_$][\w$]*\)/);
  });
});
