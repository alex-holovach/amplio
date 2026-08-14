import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runInit } from "../src/commands/init.js";
import {
  runAddEnricher,
  runAddPlugin,
  runAddSink,
} from "../src/commands/add.js";
import {
  runDiffPlugin,
  runRemovePlugin,
} from "../src/commands/plugin-lifecycle.js";
import { runDoctor } from "../src/commands/doctor.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const monorepoRegistry = path.resolve(
  cliRoot,
  "../../registry/registry.manifest.json",
);

const makeHonoProject = async (): Promise<string> => {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-hono-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "packed-hono-app",
        private: true,
        type: "module",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.17",
          hono: "^4.7.4",
          resend: "^4.0.0",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`,
  );
  return cwd;
};

const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

const pointAtSourceRegistry = async (cwd: string): Promise<void> => {
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = monorepoRegistry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
};

describe("vNext Event + Plugin install", () => {
  it("init --yes creates the first Hono Event boundary without alpha directories", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const runtimePath = path.join(cwd, "telemetry/runtime.ts");
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const honoPath = path.join(cwd, "telemetry/plugins/hono.ts");
    await access(runtimePath);
    await access(eventPath);
    await access(honoPath);

    for (const removed of [
      "components",
      "workloads",
      "middleware",
      "integrations",
    ]) {
      expect(await exists(path.join(cwd, "telemetry", removed))).toBe(false);
    }
    expect(await exists(path.join(cwd, "components.json"))).toBe(false);

    const runtime = await readFile(runtimePath, "utf8");
    expect(runtime).toContain('import { init } from "@useamplio/amplio"');
    expect(runtime).not.toMatch(/\blogger\b|defineWorkload|defineFact/);

    const event = await readFile(eventPath, "utf8");
    expect(event).toContain('import { event } from "@useamplio/amplio"');
    expect(event).toContain('id: "http.request"');
    expect(event).toContain("version: 1");
    expect(event).toContain("request_id: z.string()");
    expect(event).toContain("method: z.string()");
    expect(event).toContain("route: z.string()");
    expect(event).toContain("status: z.number().int().optional()");
    expect(event).toContain("/^[A-Za-z0-9_-]{1,128}$/.test(value)");
    expect(event).not.toContain("value.trim()");

    const hono = await readFile(honoPath, "utf8");
    expect(hono).toContain("export function HonoPlugin()");
    expect(hono).toContain('from "../events/http-request.js"');
    expect(hono).toContain("HttpRequest.handle");
    expect(hono).toContain("context.req.routePath");
    expect(hono).not.toContain("context.req.path");
    expect(hono).not.toContain("context.res?.status >= 400");
    expect(hono).not.toContain(": 500");
    expect(hono).not.toMatch(/defineWorkload|defineFact|useLogger|getLogger/);
  });

  it("add plugin resend mounts its exact subtree and wraps one Resend construction seam", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY);
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    await runAddPlugin("resend", { cwd, event: "http.request" });

    const pluginPath = path.join(cwd, "telemetry/plugins/resend.ts");
    const plugin = await readFile(pluginPath, "utf8");
    expect(plugin).toContain(
      'import { plugin } from "@useamplio/amplio/plugin"',
    );
    expect(plugin).toContain('id: "resend.send"');
    expect(plugin).toContain('timing: "duration"');
    expect(plugin).toContain("export const ResendPlugin = plugin(");
    expect(plugin).toContain("observe(events.sends");
    expect(plugin).toContain('provider: z.literal("resend")');
    expect(plugin).toContain("template: z.string().optional()");
    expect(plugin).not.toMatch(
      /\b(?:to|cc|bcc|from|subject|html|text|react|key)\s*:/,
    );

    const root = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(root).toContain(
      'import { ResendPlugin } from "../plugins/resend.js";',
    );
    expect(root).toContain("email: ResendPlugin.events,");

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { ResendPlugin } from "../telemetry/plugins/resend.js";',
    );
    expect(composition).toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );

    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.resend).toBe("^4.0.0");

    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      plugins: Record<string, Record<string, unknown>>;
    };
    expect(config.plugins.resend).toMatchObject({
      recipeVersion: "1.0.0",
      event: "http.request",
      branch: "email",
      source: "telemetry/plugins/resend.ts",
      compositionRoot: "src/email.ts",
      recipeDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      baseArchive: expect.stringMatching(
        /^\.amplio\/bases\/sha256-[a-f0-9]{64}\.json$/,
      ),
      stateArchive: ".amplio/installs/resend.json",
      coreRange: ">=0.1.0-alpha.17 <1",
      peers: { resend: ">=4 <5" },
      events: [{ id: "resend.send", version: 1 }],
      privacyDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      contractDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
      mounts: [
        {
          instanceKey: "default",
          rootEventId: "http.request",
          path: ["email"],
        },
      ],
      files: {
        "telemetry/plugins/resend.ts": {
          kind: "copied",
          recipePath: "plugins/resend.ts",
          baseHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        },
      },
      wiring: expect.arrayContaining([
        expect.objectContaining({
          file: "telemetry/events/http-request.ts",
          kind: "event-mount",
          beforeHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
          installedHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        }),
        expect.objectContaining({
          file: "src/email.ts",
          kind: "provider-construction",
          beforeHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
          installedHash: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        }),
      ]),
    });
    const pluginState = config.plugins.resend!;
    const baseArchive = path.join(cwd, String(pluginState.baseArchive));
    const stateArchive = path.join(cwd, String(pluginState.stateArchive));
    const base = JSON.parse(await readFile(baseArchive, "utf8")) as {
      files: Record<string, string>;
    };
    expect(base.files["telemetry/plugins/resend.ts"]).toBe(plugin);
    await access(stateArchive);

    const tracked = [
      pluginPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      compositionPath,
      configPath,
      path.join(cwd, "package.json"),
      baseArchive,
      stateArchive,
    ];
    const beforeRerun = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await runAddPlugin("resend", { cwd, event: "http.request" });

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(beforeRerun);
    expect(
      (await readFile(compositionPath, "utf8")).match(/ResendPlugin\(/g),
    ).toHaveLength(1);
  });

  it("adds the contributor recipe's non-provider dependencies before activation", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-cold-deps-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "cold-resend-app",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            hono: "^4.7.4",
            resend: "^4.0.0",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/email.ts"),
      'import { Resend } from "resend";\n\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const bin = path.join(cwd, "fake-bin");
    await mkdir(bin);
    const pnpm = path.join(bin, "pnpm");
    await writeFile(
      pnpm,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["install"])) process.exit(2);
const target = path.join(process.cwd(), "node_modules/zod");
fs.mkdirSync(target, { recursive: true });
fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name: "zod", version: "3.24.2" }));
`,
    );
    await chmod(pnpm, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      await runAddPlugin("resend", {
        cwd,
        event: "http.request",
        yes: true,
      });
    } finally {
      process.env.PATH = previousPath;
    }

    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.zod).toBe("^3.24.0 || ^4.0.0");
    expect(pkg.dependencies.resend).toBe("^4.0.0");
    expect(
      await readFile(path.join(cwd, "node_modules/zod/package.json"), "utf8"),
    ).toContain('"version":"3.24.2"');
    expect(
      await readFile(path.join(cwd, "telemetry/plugins/resend.ts"), "utf8"),
    ).toContain('from "zod"');
  });

  it("mounts and verifies the Plugin only inside the selected Event tree", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/email.ts"),
      'import { Resend } from "resend";\n\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const initial = await readFile(eventPath, "utf8");
    await writeFile(
      eventPath,
      initial
        .replace(
          "// amplio:plugin-imports",
          `const markerDecoys = \`
// amplio:plugin-imports
// amplio:plugins
\`;
void markerDecoys;
import { ResendPlugin } from "../plugins/resend.js";
// amplio:plugin-imports`,
        )
        .replace(
          "export const HttpRequest",
          `// email: ResendPlugin.events is not a selected-tree mount
export const OtherRequest = event({
  id: "other.request",
  version: 1,
  schema: z.object({}),
  tree: { email: ResendPlugin.events },
});

export const HttpRequest`,
        ),
    );

    await runAddPlugin("resend", { cwd, event: "http.request" });

    const mounted = await readFile(eventPath, "utf8");
    expect(mounted).toContain("tree: { email: ResendPlugin.events }");
    expect(mounted).toMatch(
      /export const HttpRequest[\s\S]*?tree:\s*\{\s*email:\s*ResendPlugin\.events,/,
    );
    await expect(runDoctor({ cwd })).resolves.toBe(0);

    await writeFile(
      eventPath,
      mounted.replace(/^\s*email:\s*ResendPlugin\.events,\n/m, ""),
    );
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("rejects string-only composition markers without changing Plugin files", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      'import { Resend } from "resend";\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const eventSource = (await readFile(eventPath, "utf8"))
      .replace("// amplio:plugin-imports", "")
      .replace("// amplio:plugins", "");
    const withDecoys = `const markerDecoys = \`
// amplio:plugin-imports
// amplio:plugins
\`;
void markerDecoys;
${eventSource}`;
    await writeFile(eventPath, withDecoys);
    const configPath = path.join(cwd, "amplio.json");
    const before = await Promise.all(
      [eventPath, compositionPath, configPath].map((file) =>
        readFile(file, "utf8"),
      ),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(/authenticated top-level amplio:plugin-imports marker/i);
    await expect(
      Promise.all(
        [eventPath, compositionPath, configPath].map((file) =>
          readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(before);
    await expect(
      access(path.join(cwd, "telemetry/plugins/resend.ts")),
    ).rejects.toThrow();
  });

  it.each([
    [
      "local",
      "const event = <Definition>(definition: Definition): Definition => definition;",
    ],
    ["another package", 'import { event } from "event-lookalike";'],
  ])(
    "rejects an Event lookalike from %s instead of Amplio's imported binding",
    async (_sourceKind, replacementImport) => {
      const cwd = await makeHonoProject();
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/email.ts");
      await writeFile(
        compositionPath,
        'import { Resend } from "resend";\nexport const resend = new Resend();\n',
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
      await writeFile(
        eventPath,
        (await readFile(eventPath, "utf8")).replace(
          'import { event } from "@useamplio/amplio";',
          replacementImport,
        ),
      );
      const configPath = path.join(cwd, "amplio.json");
      const before = await Promise.all(
        [eventPath, compositionPath, configPath].map((file) =>
          readFile(file, "utf8"),
        ),
      );

      await expect(
        runAddPlugin("resend", { cwd, event: "http.request" }),
      ).rejects.toThrow(/exactly one Event definition.*found 0/i);
      await expect(
        Promise.all(
          [eventPath, compositionPath, configPath].map((file) =>
            readFile(file, "utf8"),
          ),
        ),
      ).resolves.toEqual(before);
      await expect(
        access(path.join(cwd, "telemetry/plugins/resend.ts")),
      ).rejects.toThrow();
    },
  );

  it("accepts an aliased Amplio event import for the selected root Event", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/email.ts"),
      'import { Resend } from "resend";\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    await writeFile(
      eventPath,
      (await readFile(eventPath, "utf8"))
        .replace(
          'import { event } from "@useamplio/amplio";',
          'import { event as defineEvent } from "@useamplio/amplio";',
        )
        .replace(" = event({", " = defineEvent({"),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).resolves.toBeUndefined();
    expect(await readFile(eventPath, "utf8")).toContain(
      "email: ResendPlugin.events,",
    );
    await expect(runDoctor({ cwd })).resolves.toBe(0);
  });

  it("rejects an untracked contributor source that only looks like the Plugin recipe", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      'import { Resend } from "resend";\n\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pluginPath = path.join(cwd, "telemetry/plugins/resend.ts");
    const decoy = "// export const ResendPlugin = plugin();\n";
    await writeFile(pluginPath, decoy);
    const tracked = [
      pluginPath,
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(
      /untracked Plugin source that differs from the registry recipe.*--force/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("rejects a structural boundary decoy before wiring it", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const appPath = path.join(cwd, "src/app.ts");
    await writeFile(
      appPath,
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pluginPath = path.join(cwd, "telemetry/plugins/hono.ts");
    const decoy = "export function HonoPlugin() { return () => {}; }\n";
    await writeFile(pluginPath, decoy);
    const tracked = [pluginPath, appPath, path.join(cwd, "amplio.json")];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(runAddPlugin("hono", { cwd })).rejects.toThrow(
      /untracked Plugin source that differs from the registry recipe.*--force/i,
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
  });

  it("adopts exact untracked Plugin bytes and force replaces a mismatched source", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/email.ts"),
      'import { Resend } from "resend";\n\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pluginPath = path.join(cwd, "telemetry/plugins/resend.ts");
    const recipe = await readFile(
      path.resolve(cliRoot, "../../registry/plugins/resend.ts"),
      "utf8",
    );
    await writeFile(pluginPath, recipe);

    await runAddPlugin("resend", { cwd, event: "http.request" });
    expect(await readFile(pluginPath, "utf8")).toBe(recipe);

    const boundaryCwd = await makeHonoProject();
    await mkdir(path.join(boundaryCwd, "src"), { recursive: true });
    await writeFile(
      path.join(boundaryCwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await runInit({ cwd: boundaryCwd, skipInstall: true });
    await pointAtSourceRegistry(boundaryCwd);
    const boundaryPlugin = path.join(boundaryCwd, "telemetry/plugins/hono.ts");
    await writeFile(boundaryPlugin, "// unrelated customer file\n");

    await runAddPlugin("hono", { cwd: boundaryCwd, force: true });
    expect(await readFile(boundaryPlugin, "utf8")).toContain(
      "export function HonoPlugin()",
    );
  });

  it("restores a forced untracked Plugin overwrite when a later write fails", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      'import { Resend } from "resend";\n\nexport const resend = new Resend();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pluginPath = path.join(cwd, "telemetry/plugins/resend.ts");
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const decoy = "// customer-owned collision\n";
    await writeFile(pluginPath, decoy);
    const before = await Promise.all(
      [pluginPath, eventPath, compositionPath].map((file) =>
        readFile(file, "utf8"),
      ),
    );

    const originalWriteFile = fs.writeFile.bind(fs);
    let injected = false;
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (!injected && path.resolve(String(args[0])) === eventPath) {
          injected = true;
          throw new Error("injected forced adoption failure");
        }
        return originalWriteFile(...args);
      });
    try {
      await expect(
        runAddPlugin("resend", {
          cwd,
          event: "http.request",
          force: true,
        }),
      ).rejects.toThrow("injected forced adoption failure");
    } finally {
      writeSpy.mockRestore();
    }

    expect(injected).toBe(true);
    await expect(
      Promise.all(
        [pluginPath, eventPath, compositionPath].map((file) =>
          readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(before);
  });

  it("previews a complete contributor Plugin install without writing", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    const tracked = [
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );
    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runAddPlugin("resend", {
        cwd,
        event: "http.request",
        dryRun: true,
      });
    } finally {
      log.mockRestore();
    }

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
    expect(await exists(path.join(cwd, ".amplio"))).toBe(false);
    expect(output.join("\n")).toMatch(/would create.*resend\.ts/i);
    expect(output.join("\n")).toMatch(/would mount.*email/i);
    expect(output.join("\n")).toMatch(/would wire.*src\/email\.ts/i);
    expect(output.join("\n")).toMatch(/would track.*amplio\.json/i);
  });

  it("ignores Resend constructor text in comments and strings while wrapping real code", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";

const documentation = "new Resend(process.env.NOT_REAL)";
// new Resend(process.env.COMMENT_ONLY)
const matcher = /new Resend(process.env.REGEX_ONLY)/g;
export const resend = new Resend(process.env.RESEND_API_KEY);
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("resend", { cwd, event: "http.request" });

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'const documentation = "new Resend(process.env.NOT_REAL)";',
    );
    expect(composition).toContain("// new Resend(process.env.COMMENT_ONLY)");
    expect(composition).toContain(
      "const matcher = /new Resend(process.env.REGEX_ONLY)/g;",
    );
    expect(composition).toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );
    expect(composition.match(/ResendPlugin\(new Resend/g)).toHaveLength(1);
  });

  it("does not rewrite a Resend constructor lookalike inside a regex literal", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `export const matcher = /new Resend(process.env.NOT_REAL)/g;\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(
      'Expected exactly one unambiguous Resend composition root bound to a provider import from "resend"; found 0. No files were changed.',
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it("aborts with zero tracked changes when the Resend composition root is ambiguous", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const primaryPath = path.join(cwd, "src/email.ts");
    const duplicatePath = path.join(cwd, "src/backup-email.ts");
    await writeFile(
      primaryPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    await writeFile(
      duplicatePath,
      `import { Resend } from "resend";\n\nexport const backupResend = new Resend(process.env.BACKUP_RESEND_API_KEY);\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    const tracked = [
      primaryPath,
      duplicatePath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(
      'Expected exactly one unambiguous Resend composition root bound to a provider import from "resend"; found 2. No files were changed.',
    );

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it("selects one authenticated Resend seam with --target when the project has two", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const primaryPath = path.join(cwd, "src/email.jsx");
    const duplicatePath = path.join(cwd, "src/backup-email.ts");
    const primaryBefore = `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`;
    const duplicateBefore = `import { Resend } from "resend";\n\nexport const backupResend = new Resend(process.env.BACKUP_RESEND_API_KEY);\n`;
    await writeFile(primaryPath, primaryBefore);
    await writeFile(duplicatePath, duplicateBefore);
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("resend", {
      cwd,
      event: "http.request",
      target: "src/email.jsx",
    });

    expect(await readFile(primaryPath, "utf8")).toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );
    await expect(readFile(duplicatePath, "utf8")).resolves.toBe(
      duplicateBefore,
    );
    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as { plugins: { resend: { compositionRoot: string } } };
    expect(config.plugins.resend.compositionRoot).toBe("src/email.jsx");
  });

  it("rejects a --target symlink that escapes the project before Plugin writes", async () => {
    const cwd = await makeHonoProject();
    const outside = await mkdtemp(
      path.join(tmpdir(), "amplio-target-outside-"),
    );
    const outsideSource = path.join(outside, "email.ts");
    const outsideBefore = `import { Resend } from "resend";\nexport const resend = new Resend();\n`;
    await writeFile(outsideSource, outsideBefore);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await symlink(outsideSource, path.join(cwd, "src/email.ts"));
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
      path.join(cwd, "telemetry/events/http-request.ts"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", {
        cwd,
        event: "http.request",
        target: "src/email.ts",
      }),
    ).rejects.toThrow(/target.*contained relative source file.*no files/i);

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    await expect(readFile(outsideSource, "utf8")).resolves.toBe(outsideBefore);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it("rejects absolute, traversing, missing, and non-source Plugin targets before writes", async () => {
    for (const kind of ["absolute", "traversing", "missing", "non-source"]) {
      const cwd = await makeHonoProject();
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const sourcePath = path.join(cwd, "src/email.ts");
      await writeFile(
        sourcePath,
        `import { Resend } from "resend";\nexport const resend = new Resend();\n`,
      );
      await writeFile(
        path.join(cwd, "src/email.txt"),
        await readFile(sourcePath, "utf8"),
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      const target =
        kind === "absolute"
          ? sourcePath
          : kind === "traversing"
            ? "../email.ts"
            : kind === "missing"
              ? "src/missing.ts"
              : "src/email.txt";
      const tracked = [
        sourcePath,
        path.join(cwd, "package.json"),
        path.join(cwd, "amplio.json"),
        path.join(cwd, "telemetry/events/http-request.ts"),
      ];
      const before = await Promise.all(
        tracked.map((file) => readFile(file, "utf8")),
      );

      await expect(
        runAddPlugin("resend", {
          cwd,
          event: "http.request",
          target,
        }),
      ).rejects.toThrow(/target.*contained relative source file.*no files/i);
      await expect(
        Promise.all(tracked.map((file) => readFile(file, "utf8"))),
      ).resolves.toEqual(before);
      expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
        false,
      );
    }
  });

  it("aborts with zero tracked changes when a real Resend construction cannot be safely wrapped", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";

const apiKey = () => process.env.RESEND_API_KEY;
export const resend = new Resend(apiKey());
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    const tracked = [
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(/Resend construction.*--source-only/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it.each([
    ["below the supported minimum", "^3.9.0"],
    ["crossing the supported upper bound", ">=4"],
  ])(
    "refuses a Resend provider range %s without changing the host version",
    async (_label, providerRange) => {
      const cwd = await makeHonoProject();
      const packagePath = path.join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies.resend = providerRange;
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/email.ts");
      await writeFile(
        compositionPath,
        `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);

      const tracked = [
        packagePath,
        compositionPath,
        path.join(cwd, "telemetry/events/http-request.ts"),
        path.join(cwd, "amplio.json"),
      ];
      const before = await Promise.all(
        tracked.map((file) => readFile(file, "utf8")),
      );

      await expect(
        runAddPlugin("resend", { cwd, event: "http.request" }),
      ).rejects.toThrow(
        `Provider dependency "resend" range "${providerRange}" is outside supported range ">=4 <5"`,
      );
      await expect(
        Promise.all(tracked.map((file) => readFile(file, "utf8"))),
      ).resolves.toEqual(before);
      expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
        false,
      );
    },
  );

  it("refuses an incompatible Amplio core range before changing Plugin files", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["@useamplio/amplio"] = "^1.0.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const tracked = [
      packagePath,
      compositionPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", { cwd, event: "http.request" }),
    ).rejects.toThrow(
      'Core dependency "@useamplio/amplio" range "^1.0.0" is outside supported range ">=0.1.0-alpha.17 <1"',
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it.each(["workspace:*", "file:../amplio", "catalog:"])(
    "validates the manifest coreRange against a compatible installed core for %s",
    async (coreSpec) => {
      const cwd = await makeHonoProject();
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/email.ts");
      await writeFile(
        compositionPath,
        `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);

      const packagePath = path.join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies["@useamplio/amplio"] = coreSpec;
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      const installedCoreDirectory = path.join(
        cwd,
        "node_modules/@useamplio/amplio",
      );
      await mkdir(installedCoreDirectory, { recursive: true });
      await writeFile(
        path.join(installedCoreDirectory, "package.json"),
        `${JSON.stringify(
          { name: "@useamplio/amplio", version: "0.1.0-alpha.17" },
          null,
          2,
        )}\n`,
      );

      await runAddPlugin("resend", { cwd, event: "http.request" });

      expect(await readFile(compositionPath, "utf8")).toContain(
        "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
      );
      const nextPackage = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      expect(nextPackage.dependencies["@useamplio/amplio"]).toBe(coreSpec);
    },
  );

  it.each([
    ["is missing", undefined],
    ["is incompatible", "1.0.0"],
  ])(
    "fails closed when a workspace core install %s",
    async (_label, installedVersion) => {
      const cwd = await makeHonoProject();
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/email.ts");
      await writeFile(
        compositionPath,
        `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      const packagePath = path.join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies["@useamplio/amplio"] = "workspace:*";
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      if (installedVersion) {
        const installedCoreDirectory = path.join(
          cwd,
          "node_modules/@useamplio/amplio",
        );
        await mkdir(installedCoreDirectory, { recursive: true });
        await writeFile(
          path.join(installedCoreDirectory, "package.json"),
          `${JSON.stringify(
            { name: "@useamplio/amplio", version: installedVersion },
            null,
            2,
          )}\n`,
        );
      }
      const tracked = [
        packagePath,
        compositionPath,
        path.join(cwd, "telemetry/events/http-request.ts"),
        path.join(cwd, "amplio.json"),
      ];
      const before = await Promise.all(
        tracked.map((file) => readFile(file, "utf8")),
      );

      const install = runAddPlugin("resend", {
        cwd,
        event: "http.request",
      });
      if (installedVersion) {
        await expect(install).rejects.toThrow(
          `Core dependency "@useamplio/amplio" spec "workspace:*" resolves to installed version "${installedVersion}", outside supported range ">=0.1.0-alpha.17 <1"`,
        );
      } else {
        await expect(install).rejects.toThrow(
          /Core dependency.*could not resolve an installed version.*retry/i,
        );
      }
      await expect(
        Promise.all(tracked.map((file) => readFile(file, "utf8"))),
      ).resolves.toEqual(before);
      expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
        false,
      );
    },
  );

  it("does not let --source-only bypass provider compatibility", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies.resend = "^5.0.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      packagePath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("resend", {
        cwd,
        event: "http.request",
        sourceOnly: true,
      }),
    ).rejects.toThrow(
      'Provider dependency "resend" range "^5.0.0" is outside supported range ">=4 <5"',
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
      false,
    );
  });

  it("accepts a workspace provider spec when the installed package version is compatible", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies.resend = "workspace:*";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "node_modules/resend"), { recursive: true });
    await writeFile(
      path.join(cwd, "node_modules/resend/package.json"),
      `${JSON.stringify({ name: "resend", version: "4.9.0" }, null, 2)}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("resend", { cwd, event: "http.request" });

    expect(await readFile(compositionPath, "utf8")).toContain(
      "ResendPlugin(new Resend(process.env.RESEND_API_KEY))",
    );
    const nextPkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(nextPkg.dependencies.resend).toBe("workspace:*");
  });

  it.each([
    ["is missing", undefined],
    ["is incompatible", "5.0.0"],
  ])(
    "fails closed when a workspace provider install %s",
    async (_label, installedVersion) => {
      const cwd = await makeHonoProject();
      const packagePath = path.join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies.resend = "workspace:*";
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      if (installedVersion) {
        await mkdir(path.join(cwd, "node_modules/resend"), {
          recursive: true,
        });
        await writeFile(
          path.join(cwd, "node_modules/resend/package.json"),
          `${JSON.stringify(
            { name: "resend", version: installedVersion },
            null,
            2,
          )}\n`,
        );
      }
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/email.ts");
      await writeFile(
        compositionPath,
        `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      const tracked = [
        packagePath,
        compositionPath,
        path.join(cwd, "telemetry/events/http-request.ts"),
        path.join(cwd, "amplio.json"),
      ];
      const before = await Promise.all(
        tracked.map((file) => readFile(file, "utf8")),
      );

      const install = runAddPlugin("resend", {
        cwd,
        event: "http.request",
      });
      if (installedVersion) {
        await expect(install).rejects.toThrow(
          `resolves to installed version "${installedVersion}", outside supported range ">=4 <5"`,
        );
      } else {
        await expect(install).rejects.toThrow(
          /could not resolve an installed version.*install dependencies and retry/i,
        );
      }
      await expect(
        Promise.all(tracked.map((file) => readFile(file, "utf8"))),
      ).resolves.toEqual(before);
      expect(await exists(path.join(cwd, "telemetry/plugins/resend.ts"))).toBe(
        false,
      );
    },
  );

  it("installs BetterAuthPlugin at the native Better Auth plugins seam", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["better-auth"] = "^1.6.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/auth.ts");
    await writeFile(
      compositionPath,
      `import { betterAuth } from "better-auth";

export const auth = betterAuth({
  plugins: [],
});
`,
    );
    const backupPath = path.join(cwd, "src/backup-auth.ts");
    const backupBefore = `import { betterAuth } from "better-auth";

export const backupAuth = betterAuth({ plugins: [] });
`;
    await writeFile(backupPath, backupBefore);
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("better-auth", {
      cwd,
      event: "http.request",
      target: "src/auth.ts",
    });

    const pluginPath = path.join(cwd, "telemetry/plugins/better-auth.ts");
    const plugin = await readFile(pluginPath, "utf8");
    expect(plugin).toContain("export const BetterAuthPlugin = plugin(");
    expect(plugin).toContain('id: "auth.signed_in"');
    expect(plugin).toContain('id: "auth.signed_up"');

    const root = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(root).toContain(
      'import { BetterAuthPlugin } from "../plugins/better-auth.js";',
    );
    expect(root).toContain("auth: BetterAuthPlugin.events,");

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { BetterAuthPlugin } from "../telemetry/plugins/better-auth.js";',
    );
    expect(composition).toContain("plugins: [BetterAuthPlugin()],");
    await expect(readFile(backupPath, "utf8")).resolves.toBe(backupBefore);

    const beforeRerun = await Promise.all(
      [pluginPath, compositionPath, path.join(cwd, "amplio.json")].map((file) =>
        readFile(file, "utf8"),
      ),
    );
    await runAddPlugin("better-auth", {
      cwd,
      event: "http.request",
      target: "src/auth.ts",
    });
    await expect(
      Promise.all(
        [pluginPath, compositionPath, path.join(cwd, "amplio.json")].map(
          (file) => readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(beforeRerun);
  });

  it("refuses Better Auth shorthand plugins because it can override inserted instrumentation", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["better-auth"] = "^1.6.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/auth.ts");
    await writeFile(
      compositionPath,
      `import { betterAuth } from "better-auth";

const plugins = [];
export const auth = betterAuth({ plugins });
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      compositionPath,
      packagePath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("better-auth", { cwd, event: "http.request" }),
    ).rejects.toThrow(/ambiguous Better Auth config.*--source-only/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(
      await exists(path.join(cwd, "telemetry/plugins/better-auth.ts")),
    ).toBe(false);
  });

  it.each([
    [
      "object spread",
      `const base = { plugins: [] };
export const auth = betterAuth({ plugins: [], ...base });`,
    ],
    [
      "computed property",
      `const key = "plugins";
export const auth = betterAuth({ [key]: [] });`,
    ],
  ])("refuses Better Auth %s config", async (_label, configuration) => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["better-auth"] = "^1.6.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/auth.ts");
    await writeFile(
      compositionPath,
      `import { betterAuth } from "better-auth";

${configuration}
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      compositionPath,
      packagePath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("better-auth", { cwd, event: "http.request" }),
    ).rejects.toThrow(/ambiguous Better Auth config.*--source-only/i);
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(
      await exists(path.join(cwd, "telemetry/plugins/better-auth.ts")),
    ).toBe(false);
  });

  it("installs TrpcPlugin through the native t.middleware seam for every base procedure", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["@trpc/server"] = "^11.0.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/trpc.ts");
    await writeFile(
      compositionPath,
      `import { initTRPC } from "@trpc/server";

const t = initTRPC.context<{ userId?: string }>().create();
const requireUser = t.middleware(async ({ next }) => next());

export const publicProcedure = t.procedure;
export const protectedProcedure = t.procedure.use(requireUser);
`,
    );
    const backupPath = path.join(cwd, "src/backup-trpc.ts");
    const backupBefore = `import { initTRPC } from "@trpc/server";

const backup = initTRPC.create();
export const backupProcedure = backup.procedure;
`;
    await writeFile(backupPath, backupBefore);
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("trpc", {
      cwd,
      event: "http.request",
      target: "src/trpc.ts",
    });

    const pluginPath = path.join(cwd, "telemetry/plugins/trpc.ts");
    const plugin = await readFile(pluginPath, "utf8");
    expect(plugin).toContain("export const TrpcPlugin = plugin(");
    expect(plugin).not.toContain("amplioTrpcMiddleware");

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { TrpcPlugin } from "../telemetry/plugins/trpc.js";',
    );
    expect(composition).toContain(
      "const amplioMiddleware = t.middleware(TrpcPlugin());",
    );
    expect(composition).toContain(
      "publicProcedure = t.procedure.use(amplioMiddleware);",
    );
    expect(composition).toContain(
      "protectedProcedure = t.procedure.use(amplioMiddleware).use(requireUser);",
    );
    await expect(readFile(backupPath, "utf8")).resolves.toBe(backupBefore);

    const root = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(root).toContain('import { TrpcPlugin } from "../plugins/trpc.js";');
    expect(root).toContain("rpc: TrpcPlugin.events,");

    await symlink(
      path.join(cliRoot, "node_modules"),
      path.join(cwd, "node_modules"),
    );
    const tsconfigPath = path.join(cwd, "tsconfig.json");
    await writeFile(
      tsconfigPath,
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
          },
          include: ["src/**/*.ts", "telemetry/**/*.ts"],
        },
        null,
        2,
      )}\n`,
    );
    execFileSync("pnpm", ["exec", "tsc", "-p", tsconfigPath], {
      cwd: cliRoot,
      stdio: "pipe",
    });

    const beforeRerun = await Promise.all(
      [pluginPath, compositionPath, path.join(cwd, "amplio.json")].map((file) =>
        readFile(file, "utf8"),
      ),
    );
    await runAddPlugin("trpc", {
      cwd,
      event: "http.request",
      target: "src/trpc.ts",
    });
    await expect(
      Promise.all(
        [pluginPath, compositionPath, path.join(cwd, "amplio.json")].map(
          (file) => readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(beforeRerun);
  });

  it("refuses partial tRPC activation when direct procedure bases span files", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies["@trpc/server"] = "^11.0.0";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/trpc.ts");
    const externalPath = path.join(cwd, "src/router.ts");
    await writeFile(
      compositionPath,
      `import { initTRPC } from "@trpc/server";

export const t = initTRPC.create();
export const publicProcedure = t.procedure;
`,
    );
    await writeFile(
      externalPath,
      `import { t } from "./trpc.js";

export const adminProcedure = t.procedure;
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      compositionPath,
      externalPath,
      path.join(cwd, "telemetry/events/http-request.ts"),
      path.join(cwd, "amplio.json"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(
      runAddPlugin("trpc", { cwd, event: "http.request" }),
    ).rejects.toThrow("direct procedure bases span 2 files");
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/trpc.ts"))).toBe(
      false,
    );
  });

  it("uses extensionless local imports when a Next project receives a Plugin", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-next-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "next-app",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            next: "^15.2.4",
            resend: "^4.0.0",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/email.ts");
    await writeFile(
      compositionPath,
      `import { Resend } from "resend";\n\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("resend", { cwd, event: "http.request" });
    await runAddPlugin("next", { cwd, sourceOnly: true });
    await runAddSink("json", { cwd });
    await runAddEnricher("service-metadata", { cwd });

    const rootPath = path.join(cwd, "telemetry/events/http-request.ts");
    const root = await readFile(rootPath, "utf8");
    expect(root).toContain('import { ResendPlugin } from "../plugins/resend";');
    expect(root).not.toContain('../plugins/resend.js"');
    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { ResendPlugin } from "../telemetry/plugins/resend";',
    );
    expect(composition).not.toContain('../telemetry/plugins/resend.js"');

    const generated = [
      path.join(cwd, "telemetry/runtime.ts"),
      rootPath,
      path.join(cwd, "telemetry/plugins/resend.ts"),
      path.join(cwd, "telemetry/plugins/next.ts"),
      path.join(cwd, "telemetry/sinks/json.ts"),
      path.join(cwd, "telemetry/enrichers/service-metadata.ts"),
    ];
    for (const file of generated) {
      const source = await readFile(file, "utf8");
      const localSpecifiers = [
        ...source.matchAll(
          /^[ \t]*(?:(?:import|export)\b[^;]*?\bfrom\s*|import\s*)(["'])(\.{1,2}\/[^"']+)\1/gm,
        ),
      ].map((match) => match[2]!);
      expect(
        localSpecifiers,
        `${path.relative(cwd, file)} local imports`,
      ).not.toContainEqual(expect.stringMatching(/\.js$/));
    }

    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runDiffPlugin("resend", { cwd });
      await runDiffPlugin("next", { cwd });
    } finally {
      log.mockRestore();
    }
    expect(output.join("\n")).not.toContain("local source: modified");
    expect(output.join("\n").match(/local source: unchanged/g)).toHaveLength(2);
  });

  it("promotes a manually wired Next boundary to adopted active state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-next-adopted-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "next-adopted-app",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            next: "^15.2.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    await runAddPlugin("next", { cwd, sourceOnly: true });
    const routePath = path.join(cwd, "app/api/health/route.ts");
    await mkdir(path.dirname(routePath), { recursive: true });
    await writeFile(
      routePath,
      `import { withAmplio } from "../../../telemetry/plugins/next";

const handler = async () => new Response("ok");
export const GET = withAmplio("/api/health", handler);
`,
    );

    const output: string[] = [];
    const dryRunFiles = [
      routePath,
      path.join(cwd, "amplio.json"),
      path.join(cwd, "telemetry/plugins/next.ts"),
    ];
    const beforeDryRun = await Promise.all(
      dryRunFiles.map((file) => readFile(file, "utf8")),
    );
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runAddPlugin("next", {
        cwd,
        target: "app/api/health/route.ts",
        dryRun: true,
      });
    } finally {
      log.mockRestore();
    }
    await expect(
      Promise.all(dryRunFiles.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(beforeDryRun);
    expect(output.join("\n")).toMatch(
      /adopt verified customer-owned boundary.*route\.ts/i,
    );
    expect(output.join("\n")).toMatch(
      /customer composition seam is verified but not rewritten/i,
    );

    let rewroteRoute = false;
    const originalWriteFile = fs.writeFile.bind(fs);
    const writeSpy = vi
      .spyOn(fs, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.writeFile>) => {
        if (path.resolve(String(args[0])) === routePath) rewroteRoute = true;
        return originalWriteFile(...args);
      });
    try {
      await runAddPlugin("next", {
        cwd,
        target: "app/api/health/route.ts",
      });
    } finally {
      writeSpy.mockRestore();
    }
    expect(rewroteRoute).toBe(false);

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as {
      plugins: {
        next: {
          sourceOnly?: boolean;
          compositionRoot: string;
          wiring: Array<{ ownership?: string }>;
        };
      };
    };
    expect(config.plugins.next.sourceOnly).toBeUndefined();
    expect(config.plugins.next.compositionRoot).toBe("app/api/health/route.ts");
    expect(config.plugins.next.wiring).toEqual([
      expect.objectContaining({ ownership: "adopted" }),
    ]);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

    const activeRoute = await readFile(routePath, "utf8");
    await writeFile(routePath, activeRoute.replace(", handler);", ");"));
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);

    await writeFile(routePath, activeRoute);
    const configBeforeRemove = await readFile(
      path.join(cwd, "amplio.json"),
      "utf8",
    );
    await expect(runRemovePlugin("next", { cwd })).rejects.toThrow(
      /app\/api\/health\/route\.ts.*all files were preserved/i,
    );
    await expect(readFile(routePath, "utf8")).resolves.toBe(activeRoute);
    await expect(readFile(path.join(cwd, "amplio.json"), "utf8")).resolves.toBe(
      configBeforeRemove,
    );

    const detached = `const handler = async () => new Response("ok");
export const GET = handler;
`;
    await writeFile(routePath, detached);
    await runRemovePlugin("next", { cwd });
    await expect(readFile(routePath, "utf8")).resolves.toBe(detached);
    expect(await exists(path.join(cwd, "telemetry/plugins/next.ts"))).toBe(
      false,
    );
  });

  it("promotes a manually wired Express route boundary to adopted active state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-express-adopted-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "express-adopted-app",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            express: "^4.21.2",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    await runAddPlugin("express", { cwd, sourceOnly: true });
    const appPath = path.join(cwd, "src/app.ts");
    await mkdir(path.dirname(appPath), { recursive: true });
    await writeFile(
      appPath,
      `import express from "express";
import { withAmplioRoute } from "../telemetry/plugins/express.js";

const app = express();
const handler = (_request: unknown, response: { send(value: string): void }) => response.send("ok");
app.get("/health", ...withAmplioRoute("/health", handler));
export { app };
`,
    );

    await runAddPlugin("express", { cwd, target: "src/app.ts" });

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as {
      plugins: {
        express: {
          sourceOnly?: boolean;
          compositionRoot: string;
          wiring: Array<{ ownership?: string }>;
        };
      };
    };
    expect(config.plugins.express.sourceOnly).toBeUndefined();
    expect(config.plugins.express.compositionRoot).toBe("src/app.ts");
    expect(config.plugins.express.wiring).toEqual([
      expect.objectContaining({ ownership: "adopted" }),
    ]);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

    const configBeforeRemoval = await readFile(
      path.join(cwd, "amplio.json"),
      "utf8",
    );
    const appBeforeRemoval = await readFile(appPath, "utf8");
    await expect(runRemovePlugin("express", { cwd })).rejects.toThrow(
      /still imported or referenced by src\/app\.ts.*all files were preserved/i,
    );
    await expect(readFile(appPath, "utf8")).resolves.toBe(appBeforeRemoval);
    await expect(readFile(path.join(cwd, "amplio.json"), "utf8")).resolves.toBe(
      configBeforeRemoval,
    );

    const detached = `import express from "express";\n\nconst app = express();\napp.get("/health", (_request, response) => response.send("ok"));\nexport { app };\n`;
    await writeFile(appPath, detached);
    await runRemovePlugin("express", { cwd });
    await expect(readFile(appPath, "utf8")).resolves.toBe(detached);
    expect(await exists(path.join(cwd, "telemetry/plugins/express.ts"))).toBe(
      false,
    );
  });

  it.each([
    {
      plugin: "next",
      provider: "next",
      version: "^15.2.4",
      target: "app/api/health/route.ts",
      source: `import { withAmplio } from "../../../telemetry/plugins/next";

const route = "/api/health";
const handler = async () => new Response("ok");
export const GET = withAmplio(route, handler);
`,
    },
    {
      plugin: "express",
      provider: "express",
      version: "^4.21.2",
      target: "src/app.ts",
      source: `import express from "express";
import { withAmplioRoute } from "../telemetry/plugins/express.js";

const app = express();
const handler = (_request: unknown, response: { send(value: string): void }) => response.send("ok");
app.get("/health", ...withAmplioRoute("/different", handler));
export { app };
`,
    },
  ])(
    "rejects an unverifiable manually wired $plugin boundary without promoting source-only state",
    async ({ plugin, provider, version, target, source }) => {
      const cwd = await mkdtemp(
        path.join(tmpdir(), `amplio-${plugin}-invalid-adoption-`),
      );
      await writeFile(
        path.join(cwd, "package.json"),
        `${JSON.stringify(
          {
            name: `${plugin}-invalid-adoption`,
            private: true,
            type: "module",
            dependencies: {
              "@useamplio/amplio": "0.1.0-alpha.17",
              [provider]: version,
              zod: "^3.24.2",
            },
          },
          null,
          2,
        )}\n`,
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      await runAddPlugin(plugin, { cwd, sourceOnly: true });
      const compositionPath = path.join(cwd, target);
      await mkdir(path.dirname(compositionPath), { recursive: true });
      await writeFile(compositionPath, source);
      const configPath = path.join(cwd, "amplio.json");
      const pluginPath = path.join(cwd, `telemetry/plugins/${plugin}.ts`);
      const before = await Promise.all(
        [compositionPath, configPath, pluginPath].map((file) =>
          readFile(file, "utf8"),
        ),
      );

      await expect(runAddPlugin(plugin, { cwd, target })).rejects.toThrow(
        /selected (?:Next|Express) source.*no files were changed/i,
      );
      await expect(
        Promise.all(
          [compositionPath, configPath, pluginPath].map((file) =>
            readFile(file, "utf8"),
          ),
        ),
      ).resolves.toEqual(before);
      const config = JSON.parse(before[1]!) as {
        plugins: Record<string, { sourceOnly?: boolean }>;
      };
      expect(config.plugins[plugin]?.sourceOnly).toBe(true);
    },
  );

  it("activates HonoPlugin at the selected app boundary", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/app.ts");
    await writeFile(
      compositionPath,
      `import { Hono } from "hono";

export const app = new Hono();
app.get("/health", (context) => context.text("ok"));
`,
    );
    const otherPath = path.join(cwd, "src/admin.ts");
    const otherBefore = `import { Hono } from "hono";\n\nexport const admin = new Hono();\n`;
    await writeFile(otherPath, otherBefore);
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("hono", { cwd, target: "src/app.ts" });

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { HonoPlugin } from "../telemetry/plugins/hono.js";',
    );
    expect(composition.indexOf('app.use("*", HonoPlugin());')).toBeLessThan(
      composition.indexOf('app.get("/health"'),
    );
    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(config.plugins.hono).toMatchObject({
      recipeVersion: "1.0.0",
      role: "boundary",
      event: "http.request",
      source: "telemetry/plugins/hono.ts",
      compositionRoot: "src/app.ts",
    });
    const pkg = JSON.parse(
      await readFile(path.join(cwd, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["@trpc/server"]).toBeUndefined();
    await expect(readFile(otherPath, "utf8")).resolves.toBe(otherBefore);

    const installedComposition = await readFile(compositionPath, "utf8");
    await expect(
      runAddPlugin("hono", { cwd, target: "src/admin.ts" }),
    ).rejects.toThrow(
      /already active at src\/app\.ts.*refusing to retarget.*no files were changed/i,
    );
    await expect(readFile(compositionPath, "utf8")).resolves.toBe(
      installedComposition,
    );
    await expect(readFile(otherPath, "utf8")).resolves.toBe(otherBefore);
  });

  it("makes doctor --strict fail when a tracked boundary loses its synchronous root Event resolver", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    await runAddPlugin("hono", { cwd });
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const installedEvent = await readFile(eventPath, "utf8");
    await writeFile(
      eventPath,
      installedEvent.replace(
        "export function resolveRequestId",
        "export async function resolveRequestId",
      ),
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
    await writeFile(
      eventPath,
      installedEvent.replace(
        "export function resolveRequestId",
        "export const resolveRequestId = 3;\nfunction ignoredResolver",
      ),
    );

    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it.each([
    ["HttpRequest", "export const HttpRequest", "export const WrongRequest"],
    [
      "resolveRequestId",
      "export function resolveRequestId",
      "export function wrongResolver",
    ],
    [
      "a callable resolveRequestId",
      "export function resolveRequestId",
      "export const resolveRequestId = 3;\nfunction ignoredResolver",
    ],
    [
      "a synchronous resolveRequestId",
      "export function resolveRequestId",
      "export async function resolveRequestId",
    ],
  ])(
    "rejects a boundary when its selected Event module does not export %s",
    async (_label, existingExport, wrongExport) => {
      const cwd = await makeHonoProject();
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const compositionPath = path.join(cwd, "src/app.ts");
      await writeFile(
        compositionPath,
        'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
      );
      await runInit({ cwd, skipInstall: true });
      await pointAtSourceRegistry(cwd);
      const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
      await writeFile(
        eventPath,
        (await readFile(eventPath, "utf8")).replace(
          existingExport,
          wrongExport,
        ),
      );
      const configPath = path.join(cwd, "amplio.json");
      const before = await Promise.all(
        [eventPath, compositionPath, configPath].map((file) =>
          readFile(file, "utf8"),
        ),
      );

      await expect(runAddPlugin("hono", { cwd })).rejects.toThrow(
        /selected Event module.*export HttpRequest and resolveRequestId/i,
      );
      await expect(
        Promise.all(
          [eventPath, compositionPath, configPath].map((file) =>
            readFile(file, "utf8"),
          ),
        ),
      ).resolves.toEqual(before);
      await expect(
        access(path.join(cwd, "telemetry/plugins/hono.ts")),
      ).rejects.toThrow();
    },
  );

  it("previews a boundary Plugin activation without writing", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/app.ts");
    await writeFile(
      compositionPath,
      `import { Hono } from "hono";\n\nexport const app = new Hono();\n`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      compositionPath,
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
      path.join(cwd, "telemetry/events/http-request.ts"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );
    const output: string[] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((message?: unknown) => output.push(String(message)));
    try {
      await runAddPlugin("hono", { cwd, dryRun: true });
    } finally {
      log.mockRestore();
    }

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/hono.ts"))).toBe(
      false,
    );
    expect(await exists(path.join(cwd, ".amplio"))).toBe(false);
    expect(output.join("\n")).toMatch(/hono\.ts.*would create/i);
    expect(output.join("\n")).toMatch(/would activate.*src\/app\.ts/i);
    expect(output.join("\n")).toMatch(/would track.*amplio\.json/i);
  });

  it("refuses an inert boundary install unless source-only is explicit", async () => {
    const cwd = await makeHonoProject();
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const tracked = [
      path.join(cwd, "amplio.json"),
      path.join(cwd, "package.json"),
      path.join(cwd, "telemetry/events/http-request.ts"),
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(runAddPlugin("hono", { cwd })).rejects.toThrow(
      "Rerun with --source-only",
    );
    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/hono.ts"))).toBe(
      false,
    );

    await runAddPlugin("hono", { cwd, sourceOnly: true });
    expect(await exists(path.join(cwd, "telemetry/plugins/hono.ts"))).toBe(
      true,
    );
    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(config.plugins.hono).toMatchObject({
      recipeVersion: "1.0.0",
      role: "boundary",
      event: "http.request",
      source: "telemetry/plugins/hono.ts",
      sourceOnly: true,
    });
  });

  it("refuses to activate through an incompatible existing boundary Plugin file", async () => {
    const cwd = await makeHonoProject();
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/app.ts");
    await writeFile(
      compositionPath,
      `import { Hono } from "hono";

export const app = new Hono();
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);
    const pluginPath = path.join(cwd, "telemetry/plugins/hono.ts");
    await writeFile(pluginPath, "export const SomethingElse = true;\n");
    const before = await readFile(compositionPath, "utf8");

    await expect(runAddPlugin("hono", { cwd })).rejects.toThrow(
      /untracked Plugin source.*differs from the registry recipe/i,
    );
    expect(await readFile(compositionPath, "utf8")).toBe(before);
    expect(await readFile(pluginPath, "utf8")).toBe(
      "export const SomethingElse = true;\n",
    );
  });

  it("activates FastifyPlugin before routes at one unambiguous app.register boundary", async () => {
    const cwd = await makeHonoProject();
    const packagePath = path.join(cwd, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    delete pkg.dependencies.hono;
    pkg.dependencies.fastify = "^5.2.1";
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const compositionPath = path.join(cwd, "src/app.ts");
    await writeFile(
      compositionPath,
      `import Fastify from "fastify";

export const app = Fastify();
app.get("/health", () => ({ ok: true }));
`,
    );
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("fastify", { cwd });

    const composition = await readFile(compositionPath, "utf8");
    expect(composition).toContain(
      'import { FastifyPlugin } from "../telemetry/plugins/fastify.js";',
    );
    expect(composition.indexOf("app.register(FastifyPlugin);")).toBeLessThan(
      composition.indexOf('app.get("/health"'),
    );
  });

  it("copies a contributor without inventing a provider seam only when source-only is explicit", async () => {
    const cwd = await makeHonoProject();
    await runInit({ cwd, skipInstall: true });
    await pointAtSourceRegistry(cwd);

    await runAddPlugin("better-auth", {
      cwd,
      event: "http.request",
      sourceOnly: true,
    });

    expect(
      await exists(path.join(cwd, "telemetry/plugins/better-auth.ts")),
    ).toBe(true);
    const root = await readFile(
      path.join(cwd, "telemetry/events/http-request.ts"),
      "utf8",
    );
    expect(root).not.toContain("BetterAuthPlugin.events");
    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as { plugins: Record<string, unknown> };
    expect(config.plugins["better-auth"]).toMatchObject({
      recipeVersion: "1.0.0",
      role: "contributor",
      event: "http.request",
      branch: "auth",
      source: "telemetry/plugins/better-auth.ts",
      sourceOnly: true,
    });
  });
});
