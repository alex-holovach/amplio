import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runAddEvent, runAddPlugin } from "../src/commands/add.js";
import { runInit } from "../src/commands/init.js";
import {
  runDiffPlugin,
  runRemovePlugin,
  runUpdatePlugin,
} from "../src/commands/plugin-lifecycle.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const originalRecipePath = path.resolve(
  cliRoot,
  "../../registry/plugins/resend.ts",
);
const originalHonoRecipePath = path.resolve(
  cliRoot,
  "../../registry/plugins/hono.ts",
);
const originalHttpEventRecipePath = path.resolve(
  cliRoot,
  "../../registry/events/http-request.ts",
);
const monorepoRegistry = path.resolve(
  cliRoot,
  "../../registry/registry.manifest.json",
);

const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

async function writeRegistry(
  cwd: string,
  recipeVersion: string,
  source: string,
  instrumenter = "ResendPlugin",
  eventVersion = 1,
  overrides: {
    dependencies?: string[];
    privacy?: { includes: string[]; excludes: string[] };
    nativeTransformVersion?: number;
  } = {},
): Promise<string> {
  const registryDir = path.join(cwd, "test-registry");
  const sourcePath = path.join(registryDir, "plugins/resend.ts");
  const manifestPath = path.join(registryDir, "registry.manifest.json");
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, source, "utf8");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        name: "lifecycle-test",
        items: [
          {
            name: "plugin-resend",
            kind: "plugin",
            role: "contributor",
            recipeVersion,
            coreRange: ">=0.1.0-alpha.16 <1",
            providerRanges: { resend: ">=4 <5" },
            source: "plugins/resend.ts",
            target: "telemetry/plugins/resend.ts",
            events: [{ id: "resend.send", version: eventVersion }],
            placement: { branch: "email" },
            provider: {
              package: "resend",
              instrumenter,
              seam: "constructor",
              constructor: "Resend",
            },
            dependencies: overrides.dependencies ?? [
              "zod",
              "@useamplio/amplio",
              "resend@^4.0.0",
            ],
            wiringActions: [
              { type: "wrap-constructor" },
              { type: "mount-event-subtree" },
            ],
            privacy: overrides.privacy ?? {
              includes: ["provider", "template"],
              excludes: ["to", "subject", "body"],
            },
            nativeTransform: {
              version: overrides.nativeTransformVersion ?? 1,
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return manifestPath;
}

async function makeProject(): Promise<{
  cwd: string;
  recipe: string;
  compositionPath: string;
  eventPath: string;
  configPath: string;
  packagePath: string;
}> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-plugin-lifecycle-"));
  const packagePath = path.join(cwd, "package.json");
  await writeFile(
    packagePath,
    `${JSON.stringify(
      {
        name: "plugin-lifecycle-app",
        private: true,
        type: "module",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          hono: "^4.7.4",
          resend: "^4.0.0",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`,
  );
  const compositionPath = path.join(cwd, "src/email.ts");
  await mkdir(path.dirname(compositionPath), { recursive: true });
  await writeFile(
    compositionPath,
    `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
  );
  await runInit({ cwd, skipInstall: true });
  const recipe = await readFile(originalRecipePath, "utf8");
  const registry = await writeRegistry(cwd, "1.0.0", recipe);
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = registry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    cwd,
    recipe,
    compositionPath,
    eventPath: path.join(cwd, "telemetry/events/http-request.ts"),
    configPath,
    packagePath,
  };
}

describe("public Plugin lifecycle", () => {
  it("persists derived semantic and native transform contracts from a custom registry", async () => {
    const fixture = await makeProject();

    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });

    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: {
        resend: {
          semanticDigest?: string;
          events: Array<{ semanticDigest?: string }>;
          nativeTransform?: { version?: number; digest?: string };
        };
      };
    };
    expect(config.plugins.resend.semanticDigest).toMatch(
      /^sha256-[a-f0-9]{64}$/,
    );
    expect(config.plugins.resend.events).toEqual([
      expect.objectContaining({
        semanticDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      }),
    ]);
    expect(config.plugins.resend.nativeTransform).toEqual({
      version: 1,
      digest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
    });
  });

  it("diff reports source, semantic, privacy, dependency, and native transform deltas", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await writeRegistry(
      fixture.cwd,
      "2.0.0",
      fixture.recipe.replace("max: 16", "max: 32"),
      "ResendPlugin",
      1,
      {
        dependencies: ["zod@^4.0.0", "@useamplio/amplio", "resend@^4.0.0"],
        privacy: {
          includes: ["provider"],
          excludes: ["to", "subject", "body", "template"],
        },
        nativeTransformVersion: 2,
      },
    );

    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runDiffPlugin("resend", { cwd: fixture.cwd });
    } finally {
      log.mockRestore();
    }

    expect(output.join("\n")).toContain("registry source: update available");
    expect(output.join("\n")).toContain("registry semantic: changed");
    expect(output.join("\n")).toContain("registry privacy: changed");
    expect(output.join("\n")).toContain("registry dependencies: changed");
    expect(output.join("\n")).toContain(
      "registry native transform: changed (v1 → v2)",
    );
  });

  it("diffs and three-way updates a recipe while preserving non-overlapping customer edits", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const local = (await readFile(pluginPath, "utf8")).replace(
      "const instrumentedClients",
      "// Customer policy: retain one wrapper per client.\nconst instrumentedClients",
    );
    await writeFile(pluginPath, local, "utf8");
    const installedConfig = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as { plugins: { resend: { wiring: unknown[] } } };
    const installedWiring = installedConfig.plugins.resend.wiring;
    const incoming = fixture.recipe
      .replace("version: 1", "version: 2")
      .replace("max: 16", "max: 32");
    await writeRegistry(fixture.cwd, "2.0.0", incoming, "ResendPlugin", 2);

    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runDiffPlugin("resend", { cwd: fixture.cwd });
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("local source: modified");
    expect(output.join("\n")).toContain("registry source: update available");
    expect(output.join("\n")).toContain("+++ registry/plugin-resend@2.0.0");
    expect(output.join("\n")).toMatch(/^\+.*max: 32/m);

    await runUpdatePlugin("resend", { cwd: fixture.cwd });
    const merged = await readFile(pluginPath, "utf8");
    expect(merged).toContain("Customer policy");
    expect(merged).toContain("max: 32");
    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: { resend: Record<string, unknown> };
    };
    expect(config.plugins.resend.recipeVersion).toBe("2.0.0");
    expect(config.plugins.resend.recipeDigest).toMatch(/^sha256-[a-f0-9]{64}$/);
    expect(config.plugins.resend.wiring).toEqual(installedWiring);
    await access(
      path.join(fixture.cwd, String(config.plugins.resend.baseArchive)),
    );
  });

  it("never overwrites an overlapping customer edit during update", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const local = fixture.recipe.replace("max: 16", "max: 8");
    await writeFile(pluginPath, local, "utf8");
    await writeRegistry(
      fixture.cwd,
      "2.0.0",
      fixture.recipe
        .replace("version: 1", "version: 2")
        .replace("max: 16", "max: 32"),
      "ResendPlugin",
      2,
    );
    const configBefore = await readFile(fixture.configPath, "utf8");

    await expect(
      runUpdatePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(/overlapping local and registry edits/i);
    await expect(readFile(pluginPath, "utf8")).resolves.toBe(local);
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      configBefore,
    );
  });

  it("fails closed when a recipe update changes its native instrumenter contract", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const pluginBefore = await readFile(pluginPath, "utf8");
    const eventBefore = await readFile(fixture.eventPath, "utf8");
    const compositionBefore = await readFile(fixture.compositionPath, "utf8");
    const configBefore = await readFile(fixture.configPath, "utf8");
    await writeRegistry(
      fixture.cwd,
      "2.0.0",
      fixture.recipe.replaceAll("ResendPlugin", "ResendPluginV2"),
      "ResendPluginV2",
      1,
      { nativeTransformVersion: 2 },
    );

    await expect(
      runUpdatePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(
      /native transform contract.*installed v1.*registry v2.*preserved/i,
    );
    await expect(readFile(pluginPath, "utf8")).resolves.toBe(pluginBefore);
    await expect(readFile(fixture.eventPath, "utf8")).resolves.toBe(
      eventBefore,
    );
    await expect(readFile(fixture.compositionPath, "utf8")).resolves.toBe(
      compositionBefore,
    );
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      configBefore,
    );
  });

  it("fails closed when semantic Event shape changes without a wire version bump", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const pluginBefore = await readFile(pluginPath, "utf8");
    const configBefore = await readFile(fixture.configPath, "utf8");
    await writeRegistry(
      fixture.cwd,
      "2.0.0",
      fixture.recipe.replace("max: 16", "max: 32"),
    );

    await expect(
      runUpdatePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(
      /semantic shape.*resend\.send.*wire version 1.*publish version 2/i,
    );
    await expect(readFile(pluginPath, "utf8")).resolves.toBe(pluginBefore);
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      configBefore,
    );
  });

  it("removes unmodified source, reverses managed wiring, and retains the provider", async () => {
    const fixture = await makeProject();
    const eventBefore = await readFile(fixture.eventPath, "utf8");
    const compositionBefore = await readFile(fixture.compositionPath, "utf8");
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await runRemovePlugin("resend", { cwd: fixture.cwd });

    expect(
      await exists(path.join(fixture.cwd, "telemetry/plugins/resend.ts")),
    ).toBe(false);
    await expect(readFile(fixture.eventPath, "utf8")).resolves.toBe(
      eventBefore,
    );
    await expect(readFile(fixture.compositionPath, "utf8")).resolves.toBe(
      compositionBefore,
    );
    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: Record<string, unknown>;
    };
    expect(config.plugins.resend).toBeUndefined();
    const pkg = JSON.parse(await readFile(fixture.packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.resend).toBe("^4.0.0");
  });

  it("preserves customer-modified Plugin source and all wiring on remove", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const modified = `${await readFile(pluginPath, "utf8")}\n// customer edit\n`;
    await writeFile(pluginPath, modified, "utf8");
    const eventBefore = await readFile(fixture.eventPath, "utf8");
    const compositionBefore = await readFile(fixture.compositionPath, "utf8");
    const configBefore = await readFile(fixture.configPath, "utf8");

    await expect(
      runRemovePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(/has customer edits and was preserved/i);
    await expect(readFile(pluginPath, "utf8")).resolves.toBe(modified);
    await expect(readFile(fixture.eventPath, "utf8")).resolves.toBe(
      eventBefore,
    );
    await expect(readFile(fixture.compositionPath, "utf8")).resolves.toBe(
      compositionBefore,
    );
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      configBefore,
    );
  });

  it("reverses a boundary Plugin registration without touching the framework dependency", async () => {
    const fixture = await makeProject();
    const appPath = path.join(fixture.cwd, "src/app.ts");
    const appBefore = `import { Hono } from "hono";\n\nexport const app = new Hono();\n`;
    await writeFile(appPath, appBefore, "utf8");
    const config = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as Record<string, unknown>;
    config.registry = monorepoRegistry;
    await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

    await runAddPlugin("hono", { cwd: fixture.cwd });
    await runRemovePlugin("hono", { cwd: fixture.cwd });

    await expect(readFile(appPath, "utf8")).resolves.toBe(appBefore);
    expect(
      await exists(path.join(fixture.cwd, "telemetry/plugins/hono.ts")),
    ).toBe(false);
    const pkg = JSON.parse(await readFile(fixture.packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies.hono).toBe("^4.7.4");
  });

  it("can diff and remove the Hono boundary installed by init --yes", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-lifecycle-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "init-lifecycle-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    const appPath = path.join(cwd, "src/app.ts");
    const appBefore = `import { Hono } from "hono";\n\nexport const app = new Hono();\n`;
    await mkdir(path.dirname(appPath), { recursive: true });
    await writeFile(appPath, appBefore, "utf8");

    await runInit({ cwd, yes: true, skipInstall: true });
    await expect(runDiffPlugin("hono", { cwd })).resolves.toBeUndefined();
    await runRemovePlugin("hono", { cwd });

    await expect(readFile(appPath, "utf8")).resolves.toBe(appBefore);
    expect(await exists(path.join(cwd, "telemetry/plugins/hono.ts"))).toBe(
      false,
    );
  });

  it("keeps managed bytes stable under a host formatter so a fresh install can be removed", async () => {
    const fixture = await makeProject();
    await writeFile(
      path.join(fixture.cwd, ".prettierrc"),
      `${JSON.stringify({ singleQuote: true })}\n`,
    );
    const binDir = path.join(fixture.cwd, "node_modules/.bin");
    await mkdir(binDir, { recursive: true });
    await symlink(
      path.join(cliRoot, "node_modules/prettier"),
      path.join(fixture.cwd, "node_modules/prettier"),
      "dir",
    );
    await symlink(
      path.join(cliRoot, "node_modules/.bin/prettier"),
      path.join(binDir, "prettier"),
    );

    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runDiffPlugin("resend", { cwd: fixture.cwd });
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).toContain("local source: unchanged");
    await expect(
      runRemovePlugin("resend", { cwd: fixture.cwd }),
    ).resolves.toBeUndefined();
  });

  it("rejects a lifecycle cache symlink escape before Plugin writes", async () => {
    const fixture = await makeProject();
    const outside = await mkdtemp(path.join(tmpdir(), "amplio-cache-outside-"));
    await symlink(outside, path.join(fixture.cwd, ".amplio"), "dir");
    const tracked = [
      fixture.configPath,
      fixture.packagePath,
      fixture.eventPath,
      fixture.compositionPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", {
        cwd: fixture.cwd,
        event: "http.request",
      }),
    ).rejects.toThrow(/lifecycle cache resolves outside the project/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(outside, "bases"))).toBe(false);
    expect(await exists(path.join(outside, "installs"))).toBe(false);
    expect(
      await exists(path.join(fixture.cwd, "telemetry/plugins/resend.ts")),
    ).toBe(false);
  });

  it("transactionally promotes contributor source-only state to active wiring", async () => {
    const fixture = await makeProject();
    const eventBefore = await readFile(fixture.eventPath, "utf8");
    const compositionBefore = await readFile(fixture.compositionPath, "utf8");
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
      sourceOnly: true,
    });
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });

    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: {
        resend: {
          sourceOnly?: boolean;
          wiring: unknown[];
          stateArchive: string;
        };
      };
    };
    expect(config.plugins.resend.sourceOnly).toBeUndefined();
    expect(config.plugins.resend.wiring).toHaveLength(2);
    const state = JSON.parse(
      await readFile(
        path.join(fixture.cwd, config.plugins.resend.stateArchive),
        "utf8",
      ),
    ) as { files: Record<string, unknown> };
    expect(Object.keys(state.files)).toEqual(
      expect.arrayContaining([
        "telemetry/events/http-request.ts",
        "src/email.ts",
      ]),
    );

    await runRemovePlugin("resend", { cwd: fixture.cwd });
    await expect(readFile(fixture.eventPath, "utf8")).resolves.toBe(
      eventBefore,
    );
    await expect(readFile(fixture.compositionPath, "utf8")).resolves.toBe(
      compositionBefore,
    );
  });

  it("transactionally promotes boundary source-only state to active wiring", async () => {
    const fixture = await makeProject();
    const appPath = path.join(fixture.cwd, "src/app.ts");
    const appBefore = `import { Hono } from "hono";\n\nexport const app = new Hono();\n`;
    await writeFile(appPath, appBefore, "utf8");
    const config = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as Record<string, unknown>;
    config.registry = monorepoRegistry;
    await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);

    await runAddPlugin("hono", { cwd: fixture.cwd, sourceOnly: true });
    await runAddPlugin("hono", { cwd: fixture.cwd });

    const promoted = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: {
        hono: { sourceOnly?: boolean; wiring: unknown[] };
      };
    };
    expect(promoted.plugins.hono.sourceOnly).toBeUndefined();
    expect(promoted.plugins.hono.wiring).toHaveLength(1);
    await runRemovePlugin("hono", { cwd: fixture.cwd });
    await expect(readFile(appPath, "utf8")).resolves.toBe(appBefore);
  });

  it("installs and tracks the exact configured-registry Hono recipe during init", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-custom-hono-init-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "custom-hono-init",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const appPath = path.join(cwd, "src/app.ts");
    const appBefore = `import { Hono } from "hono";\n\nexport const app = new Hono();\n`;
    await writeFile(appPath, appBefore, "utf8");
    await runInit({ cwd, skipInstall: true });

    const registryDir = path.join(cwd, "custom-registry");
    const customRecipe = `// Custom registry boundary policy.\n${await readFile(originalHonoRecipePath, "utf8")}`;
    await mkdir(path.join(registryDir, "plugins"), { recursive: true });
    await mkdir(path.join(registryDir, "events"), { recursive: true });
    await writeFile(
      path.join(registryDir, "plugins/hono.ts"),
      customRecipe,
      "utf8",
    );
    await writeFile(
      path.join(registryDir, "events/http-request.ts"),
      await readFile(originalHttpEventRecipePath, "utf8"),
      "utf8",
    );
    const registryPath = path.join(registryDir, "registry.manifest.json");
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          name: "custom-hono-registry",
          items: [
            {
              name: "event-http-request",
              kind: "event",
              recipeVersion: "1.0.0",
              source: "events/http-request.ts",
              target: "telemetry/events/http-request.ts",
            },
            {
              name: "plugin-hono",
              kind: "plugin",
              role: "boundary",
              recipeVersion: "1.0.0",
              coreRange: ">=0.1.0-alpha.16 <1",
              providerRanges: { hono: ">=4 <5" },
              source: "plugins/hono.ts",
              target: "telemetry/plugins/hono.ts",
              dependencies: ["hono@^4.7.4", "@useamplio/amplio"],
              registryDependencies: ["event-http-request"],
              events: [{ id: "http.request", version: 1 }],
              nativeTransform: { version: 1 },
              wiringActions: [
                { type: "register-boundary", export: "HonoPlugin" },
              ],
              privacy: {
                includes: ["request_id", "http.method"],
                excludes: ["headers", "body"],
              },
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.registry = registryPath;
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await runInit({ cwd, yes: true, skipInstall: true });

    const pluginPath = path.join(cwd, "telemetry/plugins/hono.ts");
    await expect(readFile(pluginPath, "utf8")).resolves.toBe(customRecipe);
    await expect(runDiffPlugin("hono", { cwd })).resolves.toBeUndefined();
    await expect(runRemovePlugin("hono", { cwd })).resolves.toBeUndefined();
    await expect(readFile(appPath, "utf8")).resolves.toBe(appBefore);
  });

  it("rejects an active contributor rerun against a different root Event", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await runAddEvent("order.placed", { cwd: fixture.cwd });
    const secondEvent = path.join(
      fixture.cwd,
      "telemetry/events/order-placed.ts",
    );
    const tracked = [
      fixture.configPath,
      fixture.eventPath,
      fixture.compositionPath,
      secondEvent,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", {
        cwd: fixture.cwd,
        event: "order.placed",
      }),
    ).rejects.toThrow(/already active.*http\.request/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rejects mutable recipe source under the installed recipe version", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await writeRegistry(
      fixture.cwd,
      "1.0.0",
      fixture.recipe.replace("max: 16", "max: 32"),
    );
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const tracked = [
      fixture.configPath,
      pluginPath,
      fixture.eventPath,
      fixture.compositionPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runUpdatePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(
      /same recipeVersion.*source changed.*publish a new SemVer/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rejects a registry recipe downgrade", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await writeRegistry(fixture.cwd, "0.9.0", fixture.recipe);
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const tracked = [
      fixture.configPath,
      pluginPath,
      fixture.eventPath,
      fixture.compositionPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runUpdatePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(
      /0\.9\.0.*older than installed 1\.0\.0.*explicit migration/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("preserves every file when an untracked Event still imports the Plugin", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await runAddEvent("order.placed", { cwd: fixture.cwd });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const secondEvent = path.join(
      fixture.cwd,
      "telemetry/events/order-placed.ts",
    );
    const secondSource = await readFile(secondEvent, "utf8");
    await writeFile(
      secondEvent,
      secondSource
        .replace(
          "// amplio:plugin-imports",
          'import { ResendPlugin } from "../plugins/resend";\n// amplio:plugin-imports',
        )
        .replace(
          "// amplio:plugins",
          "email: ResendPlugin.events,\n    // amplio:plugins",
        ),
      "utf8",
    );
    const config = JSON.parse(await readFile(fixture.configPath, "utf8")) as {
      plugins: { resend: { stateArchive: string } };
    };
    const statePath = path.join(
      fixture.cwd,
      config.plugins.resend.stateArchive,
    );
    const tracked = [
      fixture.configPath,
      pluginPath,
      fixture.eventPath,
      fixture.compositionPath,
      secondEvent,
      statePath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runRemovePlugin("resend", { cwd: fixture.cwd }),
    ).rejects.toThrow(
      /telemetry\/events\/order-placed\.ts.*remove its Plugin import or reference manually/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("ignores commented Plugin imports and references during removal", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    await runAddEvent("order.placed", { cwd: fixture.cwd });
    const secondEvent = path.join(
      fixture.cwd,
      "telemetry/events/order-placed.ts",
    );
    const comment =
      '// import { ResendPlugin } from "../plugins/resend";\n// ResendPlugin.events\n';
    await writeFile(
      secondEvent,
      `${await readFile(secondEvent, "utf8")}\n${comment}`,
      "utf8",
    );

    await expect(
      runRemovePlugin("resend", { cwd: fixture.cwd }),
    ).resolves.toBeUndefined();
    await expect(readFile(secondEvent, "utf8")).resolves.toContain(comment);
  });

  it("scans app consumers when the configured registry lives in a parent workspace", async () => {
    const workspace = await mkdtemp(
      path.join(tmpdir(), "amplio-parent-registry-workspace-"),
    );
    const cwd = path.join(workspace, "app");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "parent-registry-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.16",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const appPath = path.join(cwd, "src/app.ts");
    await writeFile(
      appPath,
      `import { Hono } from "hono";\n\nexport const app = new Hono();\n`,
      "utf8",
    );
    await runInit({ cwd, skipInstall: true });

    const sourceManifest = JSON.parse(
      await readFile(monorepoRegistry, "utf8"),
    ) as { items: Array<Record<string, unknown>> };
    const honoItem = sourceManifest.items.find(
      (item) => item.name === "plugin-hono",
    );
    const eventItem = sourceManifest.items.find(
      (item) => item.name === "event-http-request",
    );
    expect(honoItem).toBeDefined();
    expect(eventItem).toBeDefined();
    await mkdir(path.join(workspace, "plugins"), { recursive: true });
    await mkdir(path.join(workspace, "events"), { recursive: true });
    await writeFile(
      path.join(workspace, "plugins/hono.ts"),
      await readFile(originalHonoRecipePath, "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "events/http-request.ts"),
      await readFile(originalHttpEventRecipePath, "utf8"),
      "utf8",
    );
    await writeFile(
      path.join(workspace, "registry.manifest.json"),
      `${JSON.stringify(
        {
          name: "parent-workspace-registry",
          items: [eventItem, honoItem],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.registry = "../registry.manifest.json";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await runInit({ cwd, yes: true, skipInstall: true });

    const manualPath = path.join(cwd, "src/manual.ts");
    await writeFile(
      manualPath,
      `import { HonoPlugin } from "../telemetry/plugins/hono.js";\n\nexport const manualBoundary = HonoPlugin;\n`,
      "utf8",
    );
    const installed = JSON.parse(await readFile(configPath, "utf8")) as {
      plugins: { hono: { source: string; stateArchive: string } };
    };
    const pluginPath = path.join(cwd, installed.plugins.hono.source);
    const statePath = path.join(cwd, installed.plugins.hono.stateArchive);
    const tracked = [configPath, appPath, manualPath, pluginPath, statePath];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(runRemovePlugin("hono", { cwd })).rejects.toThrow(
      /src\/manual\.ts.*remove its Plugin import or reference manually/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rejects downgrading an active contributor to source-only", async () => {
    const fixture = await makeProject();
    await runAddPlugin("resend", {
      cwd: fixture.cwd,
      event: "http.request",
    });
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const tracked = [
      fixture.configPath,
      fixture.eventPath,
      fixture.compositionPath,
      pluginPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", {
        cwd: fixture.cwd,
        event: "http.request",
        sourceOnly: true,
      }),
    ).rejects.toThrow(/already active.*cannot downgrade.*source-only/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rolls back a source-only recipe when lifecycle tracking fails", async () => {
    const fixture = await makeProject();
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/resend.ts");
    const beforeConfig = await readFile(fixture.configPath, "utf8");
    const beforePackage = await readFile(fixture.packagePath, "utf8");
    const originalWriteFile = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (!injected && path.resolve(String(args[0])) === fixture.configPath) {
          injected = true;
          throw new Error("injected lifecycle tracking failure");
        }
        return originalWriteFile(...args);
      });

    try {
      await expect(
        runAddPlugin("resend", {
          cwd: fixture.cwd,
          event: "http.request",
          sourceOnly: true,
        }),
      ).rejects.toThrow(/injected lifecycle tracking failure/i);
    } finally {
      writeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(readFile(fixture.configPath, "utf8")).resolves.toBe(
      beforeConfig,
    );
    await expect(readFile(fixture.packagePath, "utf8")).resolves.toBe(
      beforePackage,
    );
    expect(await exists(pluginPath)).toBe(false);
    expect(
      await exists(path.join(fixture.cwd, ".amplio/installs/resend.json")),
    ).toBe(false);
  });

  it("rolls back a boundary recipe and registration when lifecycle tracking fails", async () => {
    const fixture = await makeProject();
    const appPath = path.join(fixture.cwd, "src/app.ts");
    const pluginPath = path.join(fixture.cwd, "telemetry/plugins/hono.ts");
    await writeFile(
      appPath,
      `import { Hono } from "hono";\n\nexport const app = new Hono();\n`,
      "utf8",
    );
    const config = JSON.parse(
      await readFile(fixture.configPath, "utf8"),
    ) as Record<string, unknown>;
    config.registry = monorepoRegistry;
    await writeFile(fixture.configPath, `${JSON.stringify(config, null, 2)}\n`);
    const before = await Promise.all(
      [fixture.configPath, fixture.packagePath, appPath].map((file) =>
        readFile(file, "utf8"),
      ),
    );
    const originalWriteFile = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (!injected && path.resolve(String(args[0])) === fixture.configPath) {
          injected = true;
          throw new Error("injected boundary tracking failure");
        }
        return originalWriteFile(...args);
      });

    try {
      await expect(runAddPlugin("hono", { cwd: fixture.cwd })).rejects.toThrow(
        /injected boundary tracking failure/i,
      );
    } finally {
      writeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(
      Promise.all(
        [fixture.configPath, fixture.packagePath, appPath].map((file) =>
          readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(before);
    expect(await exists(pluginPath)).toBe(false);
    expect(
      await exists(path.join(fixture.cwd, ".amplio/installs/hono.json")),
    ).toBe(false);
  });
});
