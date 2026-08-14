import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { runAddPlugin } from "../src/commands/add.js";

describe("init boundary activation", () => {
  it.each([
    ["telemetry/events/http-request.ts", "export const NotHttpRequest = {};\n"],
    ["telemetry/runtime.ts", "export const unrelatedRuntime = true;\n"],
  ])(
    "rejects a fresh untracked collision at %s before wiring or dependency changes",
    async (relativeCollision, collisionSource) => {
      const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-collision-"));
      const packagePath = path.join(cwd, "package.json");
      const packageSource = `${JSON.stringify(
        {
          name: "hono-collision",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`;
      await writeFile(packagePath, packageSource);
      await mkdir(path.join(cwd, "src"), { recursive: true });
      const appPath = path.join(cwd, "src/app.ts");
      const appSource =
        'import { Hono } from "hono";\n\nexport const app = new Hono();\n';
      await writeFile(appPath, appSource);
      const collisionPath = path.join(cwd, relativeCollision);
      await mkdir(path.dirname(collisionPath), { recursive: true });
      await writeFile(collisionPath, collisionSource);

      await expect(
        runInit({ cwd, yes: true, skipInstall: true }),
      ).rejects.toThrow(
        /untracked generated file.*--force.*no files were changed/i,
      );

      expect(await readFile(packagePath, "utf8")).toBe(packageSource);
      expect(await readFile(appPath, "utf8")).toBe(appSource);
      expect(await readFile(collisionPath, "utf8")).toBe(collisionSource);
      await expect(access(path.join(cwd, "amplio.json"))).rejects.toThrow();

      await runInit({ cwd, yes: true, skipInstall: true, force: true });
      expect(await readFile(collisionPath, "utf8")).not.toBe(collisionSource);
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
    },
  );

  it("does not treat a precreated config as provenance for an invalid root Event", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-config-only-"));
    const packagePath = path.join(cwd, "package.json");
    const packageSource = `${JSON.stringify(
      {
        name: "configured-hono",
        private: true,
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.17",
          hono: "^4.7.4",
          zod: "^3.24.2",
        },
      },
      null,
      2,
    )}\n`;
    await writeFile(packagePath, packageSource);
    await writeFile(
      path.join(cwd, "amplio.json"),
      '{"telemetryDir":"telemetry","packageManager":"pnpm"}\n',
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const appPath = path.join(cwd, "src/app.ts");
    const appSource =
      'import { Hono } from "hono";\nexport const app = new Hono();\n';
    await writeFile(appPath, appSource);
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    await mkdir(path.dirname(eventPath), { recursive: true });
    const invalidEvent = "export const NotHttpRequest = {};\n";
    await writeFile(eventPath, invalidEvent);

    await expect(
      runInit({ cwd, yes: true, skipInstall: true }),
    ).rejects.toThrow(
      /untracked generated file.*--force.*no files were changed/i,
    );

    expect(await readFile(packagePath, "utf8")).toBe(packageSource);
    expect(await readFile(appPath, "utf8")).toBe(appSource);
    expect(await readFile(eventPath, "utf8")).toBe(invalidEvent);
    await expect(
      access(path.join(cwd, "telemetry/plugins/hono.ts")),
    ).rejects.toThrow();
  });

  it.each([
    [
      "telemetry/runtime.ts",
      'import { init } from "@useamplio/amplio";\nimport { consoleSink } from "./sinks/console.js";\ninit({});\n',
    ],
    [
      "telemetry/sinks/console.ts",
      'import type { Sink } from "@useamplio/amplio";\nexport const consoleSink = 1;\n',
    ],
    [
      "telemetry/events/http-request.ts",
      'import { event } from "@useamplio/amplio";\nexport const HttpRequest = event({ id: "http.request" });\n',
    ],
  ])(
    "rejects a provenance-tracked but structurally invalid %s",
    async (relativeFile, invalidSource) => {
      const cwd = await mkdtemp(
        path.join(tmpdir(), "amplio-init-invalid-managed-"),
      );
      await writeFile(
        path.join(cwd, "package.json"),
        `${JSON.stringify(
          {
            name: "managed-hono",
            private: true,
            dependencies: {
              "@useamplio/amplio": "0.1.0-alpha.17",
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
      await writeFile(
        appPath,
        'import { Hono } from "hono";\nexport const app = new Hono();\n',
      );
      await runInit({ cwd, skipInstall: true });
      const managedPath = path.join(cwd, relativeFile);
      await writeFile(managedPath, invalidSource);
      const configPath = path.join(cwd, "amplio.json");
      const before = await Promise.all(
        [managedPath, configPath, appPath, path.join(cwd, "package.json")].map(
          (file) => readFile(file, "utf8"),
        ),
      );

      await expect(
        runInit({ cwd, yes: true, skipInstall: true }),
      ).rejects.toThrow(/differs from the Amplio template.*--force/i);
      await expect(
        Promise.all(
          [
            managedPath,
            configPath,
            appPath,
            path.join(cwd, "package.json"),
          ].map((file) => readFile(file, "utf8")),
        ),
      ).resolves.toEqual(before);
    },
  );

  it("preserves structurally valid customer edits backed by scaffold provenance", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-customized-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "customized-hono",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      'import { Hono } from "hono";\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, skipInstall: true });
    const customized = [
      path.join(cwd, "telemetry/runtime.ts"),
      path.join(cwd, "telemetry/sinks/console.ts"),
      path.join(cwd, "telemetry/events/http-request.ts"),
    ];
    for (const file of customized) {
      await writeFile(
        file,
        `${await readFile(file, "utf8")}\n// customer customization preserved\n`,
      );
    }
    const before = await Promise.all(
      customized.map((file) => readFile(file, "utf8")),
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    await expect(
      Promise.all(customized.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
  });

  it("activates the detected Hono boundary and leaves doctor --strict green", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-boundary-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      `import { Hono } from "hono";

export const app = new Hono();
app.get("/health", (context) => context.json({ ok: true }));
`,
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const appSource = await readFile(appPath, "utf8");
    expect(appSource).toContain(
      'import { HonoPlugin } from "../telemetry/plugins/hono.js";',
    );
    expect(appSource).toContain('app.use("*", HonoPlugin());');

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as {
      plugins?: Record<string, unknown>;
    };
    expect(config.plugins).toMatchObject({
      hono: {
        recipeVersion: "1.0.0",
        role: "boundary",
        event: "http.request",
        source: "telemetry/plugins/hono.ts",
        compositionRoot: "src/app.ts",
      },
    });
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
  });

  it("tracks Hono when a later init activates an existing project idempotently", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-repeat-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      `import { Hono } from "hono";

export const app = new Hono();
`,
    );

    await runInit({ cwd, skipInstall: true });
    const configPath = path.join(cwd, "amplio.json");
    const initialConfig = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      configPath,
      `${JSON.stringify({ ...initialConfig, custom: "preserved" }, null, 2)}\n`,
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const activatedConfig = JSON.parse(await readFile(configPath, "utf8")) as {
      custom?: string;
      plugins?: Record<string, unknown>;
    };
    expect(activatedConfig.custom).toBe("preserved");
    expect(activatedConfig.plugins?.hono).toMatchObject({
      recipeVersion: "1.0.0",
      role: "boundary",
      event: "http.request",
      source: "telemetry/plugins/hono.ts",
      compositionRoot: "src/app.ts",
    });
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

    const beforeRepeat = await Promise.all([
      readFile(configPath, "utf8"),
      readFile(appPath, "utf8"),
    ]);
    await runInit({ cwd, yes: true, skipInstall: true });
    await expect(
      Promise.all([readFile(configPath, "utf8"), readFile(appPath, "utf8")]),
    ).resolves.toEqual(beforeRepeat);
  });

  it("refuses to retarget an already tracked Hono boundary during init", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-retarget-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
            hono: "^4.7.4",
            zod: "^3.24.2",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const firstPath = path.join(cwd, "src/app.ts");
    await writeFile(
      firstPath,
      'import { Hono } from "hono";\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, yes: true, skipInstall: true });
    await rm(firstPath);
    const movedPath = path.join(cwd, "src/moved.ts");
    const movedSource =
      'import { Hono } from "hono";\nexport const moved = new Hono();\n';
    await writeFile(movedPath, movedSource);
    const configPath = path.join(cwd, "amplio.json");
    const before = await Promise.all(
      [configPath, movedPath, path.join(cwd, "package.json")].map((file) =>
        readFile(file, "utf8"),
      ),
    );

    await expect(
      runInit({ cwd, yes: true, skipInstall: true }),
    ).rejects.toThrow(
      /already active at src\/app\.ts.*refusing to retarget.*remove and reinstall.*no files were changed/i,
    );
    await expect(
      Promise.all(
        [configPath, movedPath, path.join(cwd, "package.json")].map((file) =>
          readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(before);
    expect(await readFile(movedPath, "utf8")).toBe(movedSource);
  });

  it("promotes a source-only Hono Plugin to fully tracked init wiring", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-promotion-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      'import { Hono } from "hono";\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, skipInstall: true });
    await runAddPlugin("hono", { cwd, sourceOnly: true });

    await runInit({ cwd, yes: true, skipInstall: true });

    const config = JSON.parse(
      await readFile(path.join(cwd, "amplio.json"), "utf8"),
    ) as {
      plugins: Record<
        string,
        { sourceOnly?: boolean; wiring?: unknown[]; compositionRoot?: string }
      >;
    };
    expect(config.plugins.hono).toMatchObject({
      compositionRoot: "src/app.ts",
    });
    expect(config.plugins.hono?.sourceOnly).not.toBe(true);
    expect(config.plugins.hono?.wiring).toHaveLength(1);
    expect(await readFile(appPath, "utf8")).toContain(
      'app.use("*", HonoPlugin());',
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
  });

  it("does not mistake a commented Hono registration for a live boundary", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-comment-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      `import { Hono } from "hono";

export const app = new Hono();
// app.use("*", HonoPlugin()); TODO: instrumentation
`,
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const activated = await readFile(appPath, "utf8");
    expect(
      activated
        .split("\n")
        .filter((line) => line.trim() === 'app.use("*", HonoPlugin());'),
    ).toHaveLength(1);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

    await writeFile(
      appPath,
      activated
        .split("\n")
        .filter((line) => line.trim() !== 'app.use("*", HonoPlugin());')
        .join("\n"),
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it("does not mistake a commented Plugin import for a live Hono import", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-import-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    const pluginImport =
      'import { HonoPlugin } from "../telemetry/plugins/hono.js";';
    await writeFile(
      appPath,
      `import { Hono } from "hono";
// ${pluginImport}

export const app = new Hono();
`,
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const activated = await readFile(appPath, "utf8");
    expect(
      activated.split("\n").filter((line) => line.trim() === pluginImport),
    ).toHaveLength(1);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

    await writeFile(
      appPath,
      activated
        .split("\n")
        .filter((line) => line.trim() !== pluginImport)
        .join("\n"),
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it("inserts the Plugin import after a complete multiline provider import", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-multiline-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "hono-api",
          private: true,
          type: "module",
          dependencies: {
            "@useamplio/amplio": "0.1.0-alpha.17",
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
    await writeFile(
      appPath,
      `import {
  Hono,
  type Context,
} from "hono";

export const app = new Hono();
export type AppContext = Context;
`,
    );

    await runInit({ cwd, yes: true, skipInstall: true });

    const activated = await readFile(appPath, "utf8");
    expect(activated).toContain(
      '} from "hono";\nimport { HonoPlugin } from "../telemetry/plugins/hono.js";',
    );
    expect(activated).not.toContain(
      'import {\nimport { HonoPlugin } from "../telemetry/plugins/hono.js";',
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
  });

  it("aborts before dependency or generated writes when the detected Hono boundary is ambiguous", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-init-ambiguous-"));
    const packagePath = path.join(cwd, "package.json");
    await writeFile(
      packagePath,
      `${JSON.stringify(
        {
          name: "ambiguous-hono-api",
          private: true,
          type: "module",
          dependencies: {
            hono: "^4.7.4",
          },
        },
        null,
        2,
      )}\n`,
    );
    await mkdir(path.join(cwd, "src"), { recursive: true });
    const firstPath = path.join(cwd, "src/first.ts");
    const secondPath = path.join(cwd, "src/second.ts");
    await writeFile(
      firstPath,
      'import { Hono } from "hono";\nexport const first = new Hono();\n',
    );
    await writeFile(
      secondPath,
      'import { Hono } from "hono";\nexport const second = new Hono();\n',
    );
    const before = await Promise.all(
      [packagePath, firstPath, secondPath].map((file) =>
        readFile(file, "utf8"),
      ),
    );

    await expect(
      runInit({
        cwd,
        yes: true,
        packageManager: "amplio-test-missing-package-manager" as "pnpm",
      }),
    ).rejects.toThrow(
      /Expected exactly one unambiguous new Hono\(\.\.\.\) application boundary bound to a provider import from "hono"; found 2/,
    );

    await expect(
      Promise.all(
        [packagePath, firstPath, secondPath].map((file) =>
          readFile(file, "utf8"),
        ),
      ),
    ).resolves.toEqual(before);
    await expect(access(path.join(cwd, "amplio.json"))).rejects.toThrow();
    await expect(access(path.join(cwd, "telemetry"))).rejects.toThrow();
  });
});
