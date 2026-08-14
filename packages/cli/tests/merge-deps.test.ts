import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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

    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    );
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
    const changed = await mergePackageDependencies(
      cwd,
      ["@useamplio/amplio", "zod"],
      [],
    );
    expect(changed).toBe(true);
    log.mockRestore();

    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    );
    expect(pkg.dependencies["@useamplio/amplio"]).toMatch(/^\^/);
    expect(pkg.dependencies["@useamplio/amplio"]).not.toBe("*");
    expect(pkg.dependencies.zod).toBe("^3.24.0 || ^4.0.0");
  });

  it("does not rewrite package.json when nothing changed", async () => {
    const cwd = await makeTempDir("amplio-merge-noop-");
    const before =
      JSON.stringify({ name: "x", dependencies: { hono: "^4" } }, null, 2) +
      "\n";
    await writeFile(path.join(cwd, "package.json"), before);

    const changed = await mergePackageDependencies(cwd, ["hono"], []);
    expect(changed).toBe(false);
    expect(await readFile(path.join(cwd, "package.json"), "utf8")).toBe(before);
  });

  it("promotes runtime dependencies out of devDependencies without moving recipe type dependencies", async () => {
    const cwd = await makeTempDir("amplio-merge-promote-");
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "x",
          dependencies: {},
          devDependencies: {
            "@types/express": "^5.0.0",
            "@useamplio/amplio": "workspace:*",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );

    const changed = await mergePackageDependencies(
      cwd,
      ["@useamplio/amplio", "zod"],
      ["@types/express@^5.0.0"],
    );

    expect(changed).toBe(true);
    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    );
    expect(pkg.dependencies).toEqual({
      "@useamplio/amplio": "workspace:*",
      zod: "^3.24.2",
    });
    expect(pkg.devDependencies).toEqual({
      "@types/express": "^5.0.0",
    });
  });

  it("previews runtime promotion without changing package.json", async () => {
    const cwd = await makeTempDir("amplio-merge-promote-dry-");
    const packagePath = path.join(cwd, "package.json");
    const before = `${JSON.stringify(
      {
        name: "x",
        devDependencies: { zod: "^3.24.2" },
      },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, before);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const changed = await mergePackageDependencies(cwd, ["zod"], [], true);

    expect(changed).toBe(false);
    expect(log.mock.calls.flat().join("\n")).toMatch(
      /would move.*zod.*devDependencies.*dependencies/i,
    );
    expect(await readFile(packagePath, "utf8")).toBe(before);
    log.mockRestore();
  });

  it("survives npm ci --omit=dev with runtime dependencies only", async () => {
    const cwd = await makeTempDir("amplio-merge-production-");
    const localPackages = {
      "@types/express": path.join(cwd, "local/types-express"),
      "@useamplio/amplio": path.join(cwd, "local/amplio"),
      zod: path.join(cwd, "local/zod"),
    };
    for (const [name, directory] of Object.entries(localPackages)) {
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "package.json"),
        `${JSON.stringify({ name, version: "1.0.0", main: "index.js" })}\n`,
      );
      await writeFile(
        path.join(directory, "index.js"),
        "module.exports = {};\n",
      );
    }
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "production-fixture",
          private: true,
          devDependencies: Object.fromEntries(
            Object.entries(localPackages).map(([name, directory]) => [
              name,
              `file:${path.relative(cwd, directory)}`,
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );

    await mergePackageDependencies(
      cwd,
      ["@useamplio/amplio", "zod"],
      ["@types/express"],
    );
    execFileSync(
      "npm",
      [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
      ],
      { cwd, stdio: "pipe" },
    );
    execFileSync(
      "npm",
      ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
      { cwd, stdio: "pipe" },
    );

    await expect(
      access(path.join(cwd, "node_modules/@useamplio/amplio/package.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(cwd, "node_modules/zod/package.json")),
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(cwd, "node_modules/@types/express/package.json")),
    ).rejects.toThrow();
  });
});
