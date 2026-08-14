import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runAddPlugin } from "../src/commands/add.js";
import { runInit } from "../src/commands/init.js";
import type { RegistryItem } from "../src/registry/types.js";
import { ensurePluginProviderDependency } from "../src/utils/provider-dependency.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRegistry = path.resolve(
  cliRoot,
  "../../registry/registry.manifest.json",
);

const ResendPlugin: RegistryItem = {
  name: "plugin-resend",
  type: "registry:file",
  kind: "plugin",
  role: "contributor",
  recipeVersion: "1.0.0",
  coreRange: ">=0.1.0-alpha.16 <1",
  providerRanges: { resend: ">=4 <5" },
  dependencies: ["zod", "@useamplio/amplio", "resend@^4.0.0"],
  provider: {
    package: "resend",
    constructor: "Resend",
    instrumenter: "ResendPlugin",
    seam: "constructor",
  },
  files: [],
};

const ExpressPlugin: RegistryItem = {
  name: "plugin-express",
  type: "registry:file",
  kind: "plugin",
  role: "boundary",
  recipeVersion: "1.0.0",
  coreRange: ">=0.1.0-alpha.16 <1",
  providerRanges: { express: ">=4 <6" },
  dependencies: ["express@^4.21.2", "@useamplio/amplio"],
  devDependencies: ["@types/express@^5.0.0"],
  provider: {
    package: "express",
    instrumenter: "withAmplioRoute",
    seam: "registration",
  },
  files: [],
};

async function makeProject(
  providerRange?: string,
): Promise<{ cwd: string; packagePath: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-provider-dep-"));
  const packagePath = path.join(cwd, "package.json");
  await writeFile(
    packagePath,
    `${JSON.stringify(
      {
        name: "provider-fixture",
        private: true,
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
          ...(providerRange ? { resend: providerRange } : {}),
        },
      },
      null,
      2,
    )}\n`,
  );
  return { cwd, packagePath };
}

describe("Plugin provider dependency install", () => {
  it("previews the exact provider spec and allowed range without prompting or writing", async () => {
    const { cwd, packagePath } = await makeProject();
    const before = await readFile(packagePath, "utf8");
    const confirm = vi.fn(async () => true);
    const install = vi.fn(async () => ({ ok: true, output: "" }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        dryRun: true,
        confirm,
        install,
      }),
    ).resolves.toMatchObject({ status: "preview" });

    expect(log.mock.calls.flat().join("\n")).toContain(
      'resend@^4.0.0 (allowed range ">=4 <5")',
    );
    expect(log.mock.calls.flat().join("\n")).toMatch(
      /package-manager cache, node_modules, and dependency lifecycle scripts are not reversible/i,
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(await readFile(packagePath, "utf8")).toBe(before);
    log.mockRestore();
  });

  it("aborts with zero writes when approval is refused", async () => {
    const { cwd, packagePath } = await makeProject();
    const before = await readFile(packagePath, "utf8");
    const install = vi.fn(async () => ({ ok: true, output: "" }));
    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    let outputAtPrompt = "";

    try {
      await expect(
        ensurePluginProviderDependency({
          cwd,
          item: ResendPlugin,
          packageManager: "pnpm",
          confirm: async () => {
            outputAtPrompt = output.join("\n");
            return false;
          },
          install,
        }),
      ).rejects.toThrow(/approval declined.*--yes.*no files were changed/i);
    } finally {
      log.mockRestore();
    }

    expect(install).not.toHaveBeenCalled();
    expect(outputAtPrompt).toMatch(
      /package-manager cache, node_modules, and dependency lifecycle scripts are not reversible/i,
    );
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });

  it("moves a runtime recipe dependency out of devDependencies", async () => {
    const { cwd, packagePath } = await makeProject();
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "dev-only-runtime-fixture",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            resend: "^4.2.0",
          },
          devDependencies: {
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    const installProject = vi.fn(async () => ({ ok: true, output: "" }));

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        recipeDependencies: {
          dependencies: ResendPlugin.dependencies,
          devDependencies: [],
        },
        installProject,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toMatchObject({
      "@useamplio/amplio": "0.1.0-alpha.16",
      zod: "^3.24.0 || ^4.0.0",
      resend: "^4.2.0",
    });
    expect(pkg.devDependencies).not.toHaveProperty("zod");
    expect(installProject).toHaveBeenCalledOnce();
  });

  it("rejects a provider declared only in devDependencies", async () => {
    const { cwd, packagePath } = await makeProject();
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "dev-only-provider-fixture",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            zod: "^3.24.2",
          },
          devDependencies: { resend: "^4.2.0" },
        },
        null,
        2,
      )}\n`,
    );
    const before = await readFile(packagePath, "utf8");

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        recipeDependencies: {
          dependencies: ResendPlugin.dependencies,
          devDependencies: [],
        },
      }),
    ).rejects.toThrow(
      /provider dependency "resend" is declared only in devDependencies.*npm ci --omit=dev.*no files were changed/i,
    );
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });

  it("installs the Express runtime and type dependency closure before strict typecheck", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-express-deps-"));
    const packagePath = path.join(cwd, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "express-dependency-fixture",
          private: true,
          type: "module",
          dependencies: { "@useamplio/amplio": "0.1.0-alpha.16" },
        },
        null,
        2,
      )}\n`,
    );
    const installProject = vi.fn(async () => {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
        devDependencies: Record<string, string>;
      };
      expect(pkg.dependencies.express).toBe("^4.21.2");
      expect(pkg.devDependencies["@types/express"]).toBe("^5.0.0");
      const expressDir = path.join(cwd, "node_modules/express");
      const typesDir = path.join(cwd, "node_modules/@types/express");
      await mkdir(expressDir, { recursive: true });
      await mkdir(typesDir, { recursive: true });
      await writeFile(
        path.join(expressDir, "package.json"),
        '{"name":"express","version":"4.21.2"}\n',
      );
      await writeFile(
        path.join(typesDir, "package.json"),
        '{"name":"@types/express","version":"5.0.0","types":"index.d.ts"}\n',
      );
      await writeFile(
        path.join(typesDir, "index.d.ts"),
        'declare module "express" { export interface Request { path: string } }\n',
      );
      return { ok: true, output: "" };
    });

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ExpressPlugin,
        packageManager: "pnpm",
        yes: true,
        recipeDependencies: {
          dependencies: ExpressPlugin.dependencies,
          devDependencies: ExpressPlugin.devDependencies,
        },
        installProject,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    await writeFile(
      path.join(cwd, "probe.ts"),
      'import type { Request } from "express";\ndeclare const request: Request;\nvoid request.path;\n',
    );
    await writeFile(
      path.join(cwd, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            types: ["express"],
          },
          include: ["probe.ts"],
        },
        null,
        2,
      )}\n`,
    );
    expect(() =>
      execFileSync(
        "pnpm",
        ["exec", "tsc", "-p", path.join(cwd, "tsconfig.json")],
        {
          cwd: cliRoot,
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
    await expect(
      access(path.join(cwd, "node_modules/@types/express/package.json")),
    ).resolves.toBeUndefined();
    expect(installProject).toHaveBeenCalledOnce();
  });

  it("installs only the missing provider spec after approval", async () => {
    const { cwd, packagePath } = await makeProject();
    const install = vi.fn(async (_pm, installCwd, packages) => {
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies.resend = "^4.0.0";
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      expect(installCwd).toBe(cwd);
      return { ok: true, output: "" };
    });

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        install,
      }),
    ).resolves.toMatchObject({ status: "installed" });

    expect(install).toHaveBeenCalledWith("pnpm", cwd, ["resend@^4.0.0"], false);
  });

  it("restores package and lock files when installation fails", async () => {
    const { cwd, packagePath } = await makeProject();
    const lockPath = path.join(cwd, "pnpm-lock.yaml");
    await writeFile(lockPath, "original-lock\n");
    const beforePackage = await readFile(packagePath, "utf8");
    const install = vi.fn(async () => {
      await writeFile(packagePath, '{"mutated":true}\n');
      await writeFile(lockPath, "mutated-lock\n");
      return { ok: false, output: "provider install exploded" };
    });

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        install,
      }),
    ).rejects.toThrow(
      /provider install failed.*package\.json and lockfiles were restored.*node_modules.*may have changed/i,
    );

    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await readFile(lockPath, "utf8")).toBe("original-lock\n");
  });

  it("restores a pnpm workspace-root lockfile when installing from a package", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "amplio-provider-workspace-"),
    );
    const cwd = path.join(workspace, "packages/app");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      path.join(workspace, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n',
    );
    const lockPath = path.join(workspace, "pnpm-lock.yaml");
    await writeFile(lockPath, "original-workspace-lock\n");
    const packagePath = path.join(cwd, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "workspace-app",
          private: true,
          packageManager: "pnpm@10.0.0",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    const beforePackage = await readFile(packagePath, "utf8");

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        install: async () => {
          await writeFile(packagePath, '{"mutated":true}\n');
          await writeFile(lockPath, "mutated-workspace-lock\n");
          return { ok: false, output: "workspace install failed" };
        },
      }),
    ).rejects.toThrow(
      /provider install failed.*package\.json and lockfiles were restored.*node_modules.*may have changed/i,
    );

    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await readFile(lockPath, "utf8")).toBe("original-workspace-lock\n");
  });

  it("does not install or change an existing compatible provider declaration", async () => {
    const { cwd, packagePath } = await makeProject("^4.2.0");
    const before = await readFile(packagePath, "utf8");
    const install = vi.fn(async () => ({ ok: true, output: "" }));

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        install,
      }),
    ).resolves.toMatchObject({ status: "present" });

    expect(install).not.toHaveBeenCalled();
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });

  it("fails closed on an existing incompatible provider declaration", async () => {
    const { cwd, packagePath } = await makeProject("^5.0.0");
    const before = await readFile(packagePath, "utf8");
    const install = vi.fn(async () => ({ ok: true, output: "" }));

    await expect(
      ensurePluginProviderDependency({
        cwd,
        item: ResendPlugin,
        packageManager: "pnpm",
        yes: true,
        install,
      }),
    ).rejects.toThrow(/outside supported range ">=4 <5"/i);

    expect(install).not.toHaveBeenCalled();
    expect(await readFile(packagePath, "utf8")).toBe(before);
  });
});

async function prepareMissingResendProject(): Promise<{
  cwd: string;
  tracked: string[];
}> {
  const { cwd, packagePath } = await makeProject();
  await mkdir(path.join(cwd, "src"), { recursive: true });
  const compositionPath = path.join(cwd, "src/email.ts");
  await writeFile(
    compositionPath,
    'import { Resend } from "resend";\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n',
  );
  await runInit({ cwd, skipInstall: true });
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = sourceRegistry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    cwd,
    tracked: [
      packagePath,
      configPath,
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
    ],
  };
}

describe("add plugin provider preflight", () => {
  it("refuses a missing provider before any Plugin or wiring writes without approval", async () => {
    const { cwd, tracked } = await prepareMissingResendProject();
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );
    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));

    try {
      await expect(
        runAddPlugin("resend", { cwd, event: "http.request" }),
      ).rejects.toThrow(/approval declined.*--yes/i);
    } finally {
      log.mockRestore();
    }

    const plan = output.join("\n");
    const providerPrompt = plan.indexOf(
      "Plugin provider dependency is missing",
    );
    for (const expected of [
      "would create or retain telemetry/plugins/resend.ts",
      "would mount under email in telemetry/events/http-request.ts",
      "would wire src/email.ts",
      "would track Plugin install in amplio.json",
      "tracked rollback: package, lockfile, Plugin source, root Event, provider seam, and install state",
    ]) {
      const planEntry = plan.indexOf(expected);
      expect(planEntry, expected).toBeGreaterThanOrEqual(0);
      expect(planEntry, expected).toBeLessThan(providerPrompt);
    }

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    await expect(
      access(path.join(cwd, "telemetry/plugins/resend.ts")),
    ).rejects.toThrow();
    await expect(access(path.join(cwd, ".amplio"))).rejects.toThrow();
  });

  it("dry-runs a missing provider without prompting, installing, or writing", async () => {
    const { cwd, tracked } = await prepareMissingResendProject();
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(
      runAddPlugin("resend", {
        cwd,
        event: "http.request",
        dryRun: true,
      }),
    ).resolves.toBeUndefined();

    expect(log.mock.calls.flat().join("\n")).toContain(
      'would install provider resend@^4.0.0 (allowed range ">=4 <5")',
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    await expect(
      access(path.join(cwd, "telemetry/plugins/resend.ts")),
    ).rejects.toThrow();
    log.mockRestore();
  });

  it("--yes installs the one provider spec before activating the Plugin", async () => {
    const { cwd } = await prepareMissingResendProject();
    const bin = path.join(cwd, "test-bin");
    await mkdir(bin);
    const fakePnpm = path.join(bin, "pnpm");
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(["add", "resend@^4.0.0"])) process.exit(2);
const packagePath = path.join(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.dependencies.resend = "^4.0.0";
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\\n");
`,
    );
    await chmod(fakePnpm, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      await runAddPlugin("resend", {
        cwd,
        event: "http.request",
        yes: true,
      });
    } finally {
      process.env.PATH = originalPath;
    }

    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.resend).toBe("^4.0.0");
    await expect(
      readFile(path.join(cwd, "telemetry/plugins/resend.ts"), "utf8"),
    ).resolves.toContain("export const ResendPlugin");
    await expect(
      readFile(path.join(cwd, "src/email.ts"), "utf8"),
    ).resolves.toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );
  });

  it("restores host metadata and leaves Plugin files untouched when the approved install fails", async () => {
    const { cwd, tracked } = await prepareMissingResendProject();
    const lockPath = path.join(cwd, "pnpm-lock.yaml");
    await writeFile(lockPath, "original-lock\n");
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );
    const bin = path.join(cwd, "test-bin");
    await mkdir(bin);
    const fakePnpm = path.join(bin, "pnpm");
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), "package.json"), "{\\\"mutated\\\":true}\\n");
fs.writeFileSync(path.join(process.cwd(), "pnpm-lock.yaml"), "mutated-lock\\n");
process.exit(1);
`,
    );
    await chmod(fakePnpm, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      await expect(
        runAddPlugin("resend", {
          cwd,
          event: "http.request",
          yes: true,
        }),
      ).rejects.toThrow(
        /provider install failed.*package\.json and lockfiles were restored.*node_modules.*may have changed/i,
      );
    } finally {
      process.env.PATH = originalPath;
    }

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await readFile(lockPath, "utf8")).toBe("original-lock\n");
    await expect(
      access(path.join(cwd, "telemetry/plugins/resend.ts")),
    ).rejects.toThrow();
    await expect(access(path.join(cwd, ".amplio"))).rejects.toThrow();
  });

  it("restores provider package and lock changes when a later Plugin write fails", async () => {
    const { cwd } = await prepareMissingResendProject();
    const packagePath = path.join(cwd, "package.json");
    const lockPath = path.join(cwd, "pnpm-lock.yaml");
    const pluginPath = path.join(cwd, "telemetry/plugins/resend.ts");
    await writeFile(lockPath, "original-lock\n");
    const beforePackage = await readFile(packagePath, "utf8");
    const bin = path.join(cwd, "test-bin");
    await mkdir(bin);
    const fakePnpm = path.join(bin, "pnpm");
    await writeFile(
      fakePnpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const packagePath = path.join(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.dependencies.resend = "^4.0.0";
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\\n");
fs.writeFileSync(path.join(process.cwd(), "pnpm-lock.yaml"), "provider-lock\\n");
`,
    );
    await chmod(fakePnpm, 0o755);

    const originalWriteFile = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (!injected && path.resolve(String(args[0])) === pluginPath) {
          injected = true;
          throw new Error("injected Plugin write failure");
        }
        return originalWriteFile(...args);
      });
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      await expect(
        runAddPlugin("resend", {
          cwd,
          event: "http.request",
          yes: true,
        }),
      ).rejects.toThrow(/injected Plugin write failure/i);
    } finally {
      process.env.PATH = originalPath;
      writeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    expect(await readFile(packagePath, "utf8")).toBe(beforePackage);
    expect(await readFile(lockPath, "utf8")).toBe("original-lock\n");
    await expect(access(pluginPath)).rejects.toThrow();
  });
});
