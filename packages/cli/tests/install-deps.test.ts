import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
    expect(log.mock.calls.flat().join("\n")).toContain(
      "pnpm add @useamplio/amplio@^0.1.0-alpha.16 zod@^3.24.0",
    );
    log.mockRestore();
  });

  it("skips when deps already listed", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
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
      "npm install @useamplio/amplio@^0.1.0-alpha.16 zod@^3.24.0 --no-audit --no-fund",
    );
    log.mockRestore();
    // package.json unchanged
    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    );
    expect(pkg.dependencies).toEqual({});
  });

  it("withCliDevDependency prints a devDependency install command on skipInstall", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
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
      "npm install -D @useamplio/cli@0.1.0-alpha.16 --no-audit --no-fund",
    );
    log.mockRestore();
  });

  it("withCliDevDependency is satisfied when the CLI is already a devDependency", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
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

  it("migrates compatible runtime requirements out of devDependencies while retaining the CLI", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-placement-"));
    const packagePath = path.join(cwd, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "x",
          dependencies: {},
          devDependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            "@useamplio/cli": "0.1.0-alpha.16",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );

    const bin = path.join(cwd, "bin");
    const installMarker = path.join(cwd, "install-called");
    await mkdir(bin);
    const npm = path.join(bin, "npm");
    await writeFile(
      npm,
      `#!/bin/sh
printf 'called\n' > install-called
exit 0
`,
    );
    await chmod(npm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;

    try {
      await expect(
        ensureRuntimeDependencies({
          cwd,
          packageManager: "npm",
          withCliDevDependency: true,
        }),
      ).resolves.toBe("migrated");
    } finally {
      process.env.PATH = previousPath;
    }

    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    expect(pkg.dependencies).toEqual({
      "@useamplio/amplio": "0.1.0-alpha.16",
      zod: "^3.24.2",
    });
    expect(pkg.devDependencies).toEqual({
      "@useamplio/cli": "0.1.0-alpha.16",
    });
    expect(await readFile(installMarker, "utf8")).toBe("called\n");
  });

  it("does not accept or mutate an incompatible runtime requirement in devDependencies", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-placement-"));
    const packagePath = path.join(cwd, "package.json");
    const before = `${JSON.stringify(
      {
        name: "x",
        dependencies: { zod: "^3.24.2" },
        devDependencies: { "@useamplio/amplio": "^1.0.0" },
      },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, before);

    await expect(
      ensureRuntimeDependencies({ cwd, packageManager: "npm" }),
    ).rejects.toThrow(/Core dependency.*outside supported range/i);
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });

  it("explains dev-only runtime placement without writing under --skip-install", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-placement-"));
    const packagePath = path.join(cwd, "package.json");
    const before = `${JSON.stringify(
      {
        name: "x",
        devDependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, before);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      ensureRuntimeDependencies({
        cwd,
        packageManager: "npm",
        skipInstall: true,
      }),
    ).resolves.toBe("skipped");

    expect(log.mock.calls.flat().join("\n")).toMatch(
      /move.*@useamplio\/amplio.*zod.*devDependencies.*dependencies/i,
    );
    expect(await readFile(packagePath, "utf8")).toBe(before);
    log.mockRestore();
  });

  it("rolls back runtime promotion when a later CLI install fails", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-placement-"));
    const packagePath = path.join(cwd, "package.json");
    const lockPath = path.join(cwd, "package-lock.json");
    const beforePackage = `${JSON.stringify(
      {
        name: "x",
        devDependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, beforePackage);
    await writeFile(lockPath, '{"before":true}\n');
    const bin = path.join(cwd, "bin");
    await mkdir(bin);
    const npm = path.join(bin, "npm");
    await writeFile(
      npm,
      `#!/bin/sh
printf '{"after":true}\n' > package-lock.json
exit 23
`,
    );
    await chmod(npm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await expect(
        ensureRuntimeDependencies({
          cwd,
          packageManager: "npm",
          withCliDevDependency: true,
        }),
      ).resolves.toBe("manual");
    } finally {
      process.env.PATH = previousPath;
    }

    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await readFile(lockPath, "utf8")).toBe('{"before":true}\n');
  });

  it("rejects a project-local CLI older than the running CLI", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
        },
        devDependencies: { "@useamplio/cli": "0.1.0-alpha.15" },
      }),
    );

    await expect(
      ensureRuntimeDependencies({
        cwd,
        packageManager: "pnpm",
        withCliDevDependency: true,
      }),
    ).rejects.toThrow(
      /CLI dependency.*alpha\.15.*outside supported range.*alpha\.16/i,
    );
  });

  it.each([
    [
      "@useamplio/amplio",
      "^1.0.0",
      /Core dependency.*outside supported range/i,
    ],
    ["zod", "^2.0.0", /Zod dependency.*outside supported range/i],
  ])(
    "rejects an incompatible declared %s range",
    async (dependencyName, incompatibleRange, error) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
      const dependencies = {
        "@useamplio/amplio": "0.1.0-alpha.16",
        zod: "^3.24.2",
        [dependencyName]: incompatibleRange,
      };
      const packagePath = path.join(cwd, "package.json");
      const before = `${JSON.stringify({ name: "x", dependencies }, null, 2)}\n`;
      await writeFile(packagePath, before);

      await expect(
        ensureRuntimeDependencies({
          cwd,
          packageManager: "pnpm",
          skipInstall: true,
        }),
      ).rejects.toThrow(error);

      expect(await readFile(packagePath, "utf8")).toBe(before);
    },
  );

  it("validates workspace and catalog runtime specs from installed package versions", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "workspace:*",
          zod: "catalog:",
        },
      }),
    );
    for (const [dependencyName, version] of [
      ["@useamplio/amplio", "0.1.0-alpha.16"],
      ["zod", "4.1.0"],
    ] as const) {
      const packageDirectory = path.join(cwd, "node_modules", dependencyName);
      await mkdir(packageDirectory, { recursive: true });
      await writeFile(
        path.join(packageDirectory, "package.json"),
        JSON.stringify({ name: dependencyName, version }),
      );
    }

    await expect(
      ensureRuntimeDependencies({ cwd, packageManager: "pnpm" }),
    ).resolves.toBe("present");
  });

  it("fails closed when a non-semver runtime spec has no installed version", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      JSON.stringify({
        name: "x",
        dependencies: {
          "@useamplio/amplio": "file:../amplio",
          zod: "^3.24.2",
        },
      }),
    );

    await expect(
      ensureRuntimeDependencies({
        cwd,
        packageManager: "pnpm",
        skipInstall: true,
      }),
    ).rejects.toThrow(/could not resolve an installed version.*retry/i);
  });
});
