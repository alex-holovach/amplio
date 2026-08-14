import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAddPlugin } from "../src/commands/add.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

const cliRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceRegistry = path.resolve(
  cliRoot,
  "../../registry/registry.manifest.json",
);

const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false,
  );

async function makeProject(
  dependencies: Record<string, string>,
): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-binding-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "binding-fixture",
        private: true,
        type: "module",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.16",
          zod: "^3.24.2",
          ...dependencies,
        },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.join(cwd, "src"), { recursive: true });
  return cwd;
}

async function pointAtSourceRegistry(cwd: string): Promise<void> {
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = sourceRegistry;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function prepareContributor(
  dependency: Record<string, string>,
  filename: string,
  source: string,
): Promise<{ cwd: string; compositionPath: string }> {
  const cwd = await makeProject(dependency);
  const compositionPath = path.join(cwd, "src", filename);
  await writeFile(compositionPath, source);
  await runInit({ cwd, skipInstall: true });
  await pointAtSourceRegistry(cwd);
  return { cwd, compositionPath };
}

describe("native Plugin provider binding authentication", () => {
  it("rejects a local Hono lookalike before init writes", async () => {
    const cwd = await makeProject({ hono: "^4.7.4" });
    const appPath = path.join(cwd, "src/app.ts");
    await writeFile(
      appPath,
      `class Hono {
  use() {}
}
export const app = new Hono();
`,
    );
    const before = await Promise.all([
      readFile(path.join(cwd, "package.json"), "utf8"),
      readFile(appPath, "utf8"),
    ]);

    await expect(
      runInit({ cwd, yes: true, skipInstall: true }),
    ).rejects.toThrow(/provider import.*hono|imported.*hono/i);

    await expect(
      Promise.all([
        readFile(path.join(cwd, "package.json"), "utf8"),
        readFile(appPath, "utf8"),
      ]),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
    expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
  });

  it("rejects a local Fastify lookalike without copying Plugin source", async () => {
    const { cwd, compositionPath } = await prepareContributor(
      { fastify: "^5.0.0" },
      "app.ts",
      `function Fastify() {
  return { register() {} };
}
export const app = Fastify();
`,
    );
    const tracked = [
      path.join(cwd, "package.json"),
      path.join(cwd, "amplio.json"),
      path.join(cwd, "telemetry/events/http-request.ts"),
      compositionPath,
    ];
    const before = await Promise.all(
      tracked.map((file) => readFile(file, "utf8")),
    );

    await expect(runAddPlugin("fastify", { cwd })).rejects.toThrow(
      /provider import.*fastify|imported.*fastify/i,
    );

    await expect(
      Promise.all(tracked.map((file) => readFile(file, "utf8"))),
    ).resolves.toEqual(before);
    expect(await exists(path.join(cwd, "telemetry/plugins/fastify.ts"))).toBe(
      false,
    );
  });

  it.each([
    {
      id: "resend",
      dependency: { resend: "^4.0.0" },
      filename: "email.ts",
      source:
        "class Resend {}\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n",
    },
    {
      id: "better-auth",
      dependency: { "better-auth": "^1.6.0" },
      filename: "auth.ts",
      source:
        "function betterAuth(value: unknown) { return value; }\nexport const auth = betterAuth({ plugins: [] });\n",
    },
    {
      id: "trpc",
      dependency: { "@trpc/server": "^11.0.0" },
      filename: "trpc.ts",
      source:
        "const initTRPC = { create: () => ({ procedure: {} }) };\nexport const t = initTRPC.create();\nexport const publicProcedure = t.procedure;\n",
    },
  ])(
    "rejects a local $id provider lookalike with zero writes",
    async ({ id, dependency, filename, source }) => {
      const { cwd, compositionPath } = await prepareContributor(
        dependency,
        filename,
        source,
      );
      const tracked = [
        path.join(cwd, "package.json"),
        path.join(cwd, "amplio.json"),
        path.join(cwd, "telemetry/events/http-request.ts"),
        compositionPath,
      ];
      const before = await Promise.all(
        tracked.map((file) => readFile(file, "utf8")),
      );

      await expect(
        runAddPlugin(id, { cwd, event: "http.request" }),
      ).rejects.toThrow(/provider import|imported from/i);

      await expect(
        Promise.all(tracked.map((file) => readFile(file, "utf8"))),
      ).resolves.toEqual(before);
      expect(await exists(path.join(cwd, `telemetry/plugins/${id}.ts`))).toBe(
        false,
      );
    },
  );

  it("does not mistake a commented contributor import for a live Event-tree import", async () => {
    const { cwd } = await prepareContributor(
      { resend: "^4.0.0" },
      "email.ts",
      'import { Resend } from "resend";\nexport const resend = new Resend(process.env.RESEND_API_KEY);\n',
    );
    const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
    const pluginImport = 'import { ResendPlugin } from "../plugins/resend.js";';
    const eventSource = await readFile(eventPath, "utf8");
    await writeFile(
      eventPath,
      eventSource.replace(
        "// amplio:plugin-imports",
        `// ${pluginImport}\n// amplio:plugin-imports`,
      ),
    );

    await runAddPlugin("resend", { cwd, event: "http.request" });

    const activated = await readFile(eventPath, "utf8");
    expect(
      activated.split("\n").filter((line) => line.trim() === pluginImport),
    ).toHaveLength(1);
    await expect(runDoctor({ cwd })).resolves.toBe(0);

    await writeFile(
      eventPath,
      activated
        .split("\n")
        .filter((line) => line.trim() !== pluginImport)
        .join("\n"),
    );
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it.each([
    {
      id: "resend",
      dependency: { resend: "^4.0.0" },
      filename: "email.ts",
      source:
        'import { Resend as EmailClient } from "resend";\nexport const resend = new EmailClient(process.env.RESEND_API_KEY);\n',
      expected: "ResendPlugin(new EmailClient(process.env.RESEND_API_KEY))",
    },
    {
      id: "better-auth",
      dependency: { "better-auth": "^1.6.0" },
      filename: "auth.ts",
      source:
        'import { betterAuth as createAuth } from "better-auth";\nexport const auth = createAuth({ plugins: [] });\n',
      expected: "plugins: [BetterAuthPlugin()]",
    },
    {
      id: "trpc",
      dependency: { "@trpc/server": "^11.0.0" },
      filename: "trpc.ts",
      source:
        'import { initTRPC as createTRPC } from "@trpc/server";\nconst t = createTRPC.create();\nexport const publicProcedure = t.procedure;\n',
      expected: "const amplioMiddleware = t.middleware(TrpcPlugin());",
    },
  ])(
    "activates $id through an aliased provider import",
    async ({ id, dependency, filename, source, expected }) => {
      const { cwd, compositionPath } = await prepareContributor(
        dependency,
        filename,
        source,
      );

      await runAddPlugin(id, { cwd, event: "http.request" });

      expect(await readFile(compositionPath, "utf8")).toContain(expected);
    },
  );

  it.each([
    {
      id: "hono",
      dependency: { hono: "^4.7.4" },
      source:
        'import { Hono as WebApp } from "hono";\nexport const app = new WebApp();\n',
      expected: 'app.use("*", HonoPlugin());',
    },
    {
      id: "fastify",
      dependency: { fastify: "^5.0.0" },
      source:
        'import createFastify from "fastify";\nexport const app = createFastify();\n',
      expected: "app.register(FastifyPlugin);",
    },
  ])(
    "activates $id through an aliased boundary import",
    async ({ id, dependency, source, expected }) => {
      const cwd = await makeProject(dependency);
      const compositionPath = path.join(cwd, "src/app.ts");
      await writeFile(compositionPath, source);
      if (id === "hono") {
        await runInit({ cwd, yes: true, skipInstall: true });
      } else {
        await runInit({ cwd, skipInstall: true });
        await pointAtSourceRegistry(cwd);
        await runAddPlugin(id, { cwd });
      }

      const activated = await readFile(compositionPath, "utf8");
      expect(activated).toContain(expected);
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
      if (id === "fastify") {
        await writeFile(
          compositionPath,
          activated.replace(`${expected}\n`, ""),
        );
        await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
      }
    },
  );
});
