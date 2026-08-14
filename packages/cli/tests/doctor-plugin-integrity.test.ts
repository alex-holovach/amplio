import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import type { RegistryPluginProvider } from "../src/registry/types.js";

interface ContributorFixtureOptions {
  slug: string;
  branch: string;
  exportName: string;
  provider: RegistryPluginProvider;
  providerImport: string;
  compositionBody: string;
}

async function installedContributor(
  options: ContributorFixtureOptions = {
    slug: "resend",
    branch: "email",
    exportName: "ResendPlugin",
    provider: {
      package: "resend",
      constructor: "Resend",
      instrumenter: "ResendPlugin",
      seam: "constructor",
    },
    providerImport: 'import { Resend } from "resend";',
    compositionBody:
      "export const resend = ResendPlugin(new Resend(process.env.RESEND_API_KEY));",
  },
) {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-doctor-plugin-"));
  const telemetry = path.join(cwd, "telemetry");
  await mkdir(path.join(telemetry, "events"), { recursive: true });
  await mkdir(path.join(telemetry, "plugins"), { recursive: true });
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "amplio.json"),
    `${JSON.stringify(
      {
        telemetryDir: "telemetry",
        plugins: {
          [options.slug]: {
            recipeVersion: "1.0.0",
            role: "contributor",
            event: "http.request",
            branch: options.branch,
            source: `telemetry/plugins/${options.slug}.ts`,
            compositionRoot: "src/email.ts",
            provider: options.provider,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(telemetry, "runtime.ts"),
    'import { init } from "@useamplio/amplio";\ninit({ service: "api", env: "test", sinks: [] });\n',
  );
  const eventPath = path.join(telemetry, "events/http-request.ts");
  const mounted = `import { event } from "@useamplio/amplio";
import { ${options.exportName} } from "../plugins/${options.slug}.js";

export const HttpRequest = event({
  id: "http.request",
  version: 1,
  timing: "duration",
  tree: { ${options.branch}: ${options.exportName}.events },
});
`;
  await writeFile(eventPath, mounted);
  await writeFile(
    path.join(telemetry, `plugins/${options.slug}.ts`),
    `export const ${options.exportName} = Object.assign(() => undefined, { events: {} });\n`,
  );
  const compositionPath = path.join(cwd, "src/email.ts");
  await writeFile(
    compositionPath,
    `${options.providerImport}\nimport { ${options.exportName} } from "../telemetry/plugins/${options.slug}.js";\n${options.compositionBody}\n`,
  );
  return { cwd, eventPath, mounted, compositionPath };
}

describe("doctor Plugin integrity", () => {
  it("fails when a tracked contributor is removed from its Event tree", async () => {
    const { cwd, eventPath, mounted } = await installedContributor();

    await expect(runDoctor({ cwd })).resolves.toBe(0);

    await writeFile(
      eventPath,
      mounted.replace("tree: { email: ResendPlugin.events },", "tree: {},"),
    );
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("fails when a tracked contributor is no longer active at its provider seam", async () => {
    const { cwd, compositionPath } = await installedContributor();
    await expect(runDoctor({ cwd })).resolves.toBe(0);

    await writeFile(
      compositionPath,
      "export const resend = new Resend(process.env.RESEND_API_KEY);\n",
    );
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("rejects a Resend Plugin identifier decoy and commented wrapper", async () => {
    const { cwd, compositionPath } = await installedContributor();
    await expect(runDoctor({ cwd })).resolves.toBe(0);

    await writeFile(
      compositionPath,
      `import { Resend } from "resend";
import { ResendPlugin } from "../telemetry/plugins/resend.js";
// const old = ResendPlugin(new Resend(process.env.RESEND_API_KEY));
const pluginDecoy = ResendPlugin;
export const resend = new Resend(process.env.RESEND_API_KEY);
`,
    );
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("requires BetterAuthPlugin inside the live Better Auth plugins array", async () => {
    const fixture = await installedContributor({
      slug: "better-auth",
      branch: "auth",
      exportName: "BetterAuthPlugin",
      provider: {
        package: "better-auth",
        factory: "betterAuth",
        instrumenter: "BetterAuthPlugin",
        seam: "better-auth-plugin",
      },
      providerImport: 'import { betterAuth } from "better-auth";',
      compositionBody:
        "export const auth = betterAuth({ plugins: [BetterAuthPlugin()] });",
    });
    await expect(runDoctor({ cwd: fixture.cwd })).resolves.toBe(0);

    await writeFile(
      fixture.compositionPath,
      `import { betterAuth } from "better-auth";
import { BetterAuthPlugin } from "../telemetry/plugins/better-auth.js";
const pluginDecoy = BetterAuthPlugin;
export const auth = betterAuth({ plugins: [] });
`,
    );
    await expect(runDoctor({ cwd: fixture.cwd })).resolves.toBe(1);
  });

  it("requires TrpcPlugin middleware to be attached to direct procedures", async () => {
    const fixture = await installedContributor({
      slug: "trpc",
      branch: "rpc",
      exportName: "TrpcPlugin",
      provider: {
        package: "@trpc/server",
        initializer: "initTRPC",
        instrumenter: "TrpcPlugin",
        seam: "trpc-middleware",
      },
      providerImport: 'import { initTRPC } from "@trpc/server";',
      compositionBody: `const t = initTRPC.create();
const amplioMiddleware = t.middleware(TrpcPlugin());
export const publicProcedure = t.procedure.use(amplioMiddleware);`,
    });
    await expect(runDoctor({ cwd: fixture.cwd })).resolves.toBe(0);

    await writeFile(
      fixture.compositionPath,
      `import { initTRPC } from "@trpc/server";
import { TrpcPlugin } from "../telemetry/plugins/trpc.js";
const t = initTRPC.create();
const amplioMiddleware = t.middleware(TrpcPlugin());
export const publicProcedure = t.procedure;
`,
    );
    await expect(runDoctor({ cwd: fixture.cwd })).resolves.toBe(1);
  });
});
