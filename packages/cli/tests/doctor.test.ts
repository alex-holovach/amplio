import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";

const project = async (dependencies: Record<string, string> = {}) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-doctor-vnext-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify({ name: "doctor-app", dependencies }, null, 2)}\n`,
  );
  return cwd;
};

describe("vNext doctor", () => {
  it("passes a clean initialized Event layout", async () => {
    const cwd = await project();
    await runInit({ cwd, skipInstall: true });
    await expect(runDoctor({ cwd })).resolves.toBe(0);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it("recognizes a live multiline aliased init import with single quotes", async () => {
    const cwd = await project();
    await runInit({ cwd, skipInstall: true });
    await writeFile(
      path.join(cwd, "telemetry/runtime.ts"),
      `import {
  init as initializeAmplio,
} from '@useamplio/amplio';

initializeAmplio({ service: 'api', env: 'test', sinks: [] });
`,
    );

    await expect(runDoctor({ cwd })).resolves.toBe(0);
  });

  it("does not accept a commented Amplio import and unrelated init call", async () => {
    const cwd = await project();
    await runInit({ cwd, skipInstall: true });
    await writeFile(
      path.join(cwd, "telemetry/runtime.ts"),
      `// import { init } from '@useamplio/amplio';
function init() {}
init();
`,
    );

    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("does not mistake copied boundary source for active wiring", async () => {
    const cwd = await project({ hono: "^4.7.4" });
    await runInit({ cwd, skipInstall: true });
    await writeFile(
      path.join(cwd, "telemetry/plugins/hono.ts"),
      "export function HonoPlugin() {}\n",
    );
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it("passes strict only for a tracked boundary registered in its composition root", async () => {
    const cwd = await project({
      "@useamplio/amplio": "0.1.0-alpha.16",
      hono: "^4.7.4",
      zod: "^3.24.2",
    });
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(
      path.join(cwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, yes: true, skipInstall: true });

    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
  });

  it("fails strict for an explicitly source-only Plugin", async () => {
    const cwd = await project({ hono: "^4.7.4" });
    await runInit({ cwd, skipInstall: true });
    await writeFile(
      path.join(cwd, "telemetry/plugins/hono.ts"),
      "export function HonoPlugin() {}\n",
    );
    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.plugins = {
      hono: {
        recipeVersion: "1.0.0",
        role: "boundary",
        event: "http.request",
        source: "telemetry/plugins/hono.ts",
        sourceOnly: true,
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    await expect(runDoctor({ cwd })).resolves.toBe(0);
    await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
  });

  it("fails retired alpha directories instead of validating them", async () => {
    const cwd = await project();
    await runInit({ cwd, skipInstall: true });
    await mkdir(path.join(cwd, "telemetry/components"), { recursive: true });
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });

  it("fails a tracked contributor whose selected composition root disappeared", async () => {
    const cwd = await project();
    await runInit({ cwd, skipInstall: true });
    const configPath = path.join(cwd, "amplio.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.plugins = {
      resend: {
        event: "http.request",
        source: "telemetry/plugins/resend.ts",
        compositionRoot: "src/email.ts",
      },
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    await expect(runDoctor({ cwd })).resolves.toBe(1);
  });
});
