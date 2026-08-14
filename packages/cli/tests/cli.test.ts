import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  runAddEnricher,
  runAddEvent,
  runAddPlugin,
  runAddSink,
} from "../src/commands/add.js";
import { runInit } from "../src/commands/init.js";

const makeProject = async (dependencies: Record<string, string> = {}) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-cli-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      { name: "vnext-app", private: true, type: "module", dependencies },
      null,
      2,
    )}\n`,
  );
  return cwd;
};

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe("vNext CLI commands", () => {
  it("aborts before writing generated files when dependency setup cannot run", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-vnext-no-package-"));

    await expect(runInit({ cwd })).rejects.toThrow(
      /dependencies|package\.json/i,
    );

    expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
    expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
  });

  it.each([
    [
      "@useamplio/amplio",
      "^1.0.0",
      /Core dependency.*outside supported range/i,
    ],
    ["zod", "^2.0.0", /Zod dependency.*outside supported range/i],
  ])(
    "aborts init with zero writes when %s is incompatible",
    async (dependencyName, incompatibleRange, error) => {
      const cwd = await makeProject({
        "@useamplio/amplio": "0.1.0-alpha.16",
        zod: "^3.24.2",
        [dependencyName]: incompatibleRange,
      });
      const packagePath = path.join(cwd, "package.json");
      const before = await readFile(packagePath, "utf8");

      await expect(
        runInit({ cwd, yes: true, skipInstall: true }),
      ).rejects.toThrow(error);

      expect(await readFile(packagePath, "utf8")).toBe(before);
      expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
      expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
    },
  );

  it("aborts init with zero writes when dependency installation is refused", async () => {
    const cwd = await makeProject();
    const packagePath = path.join(cwd, "package.json");
    const before = await readFile(packagePath, "utf8");

    await expect(
      runInit({
        cwd,
        packageManager: "amplio-test-missing-package-manager" as "pnpm",
      }),
    ).rejects.toThrow(/dependencies.*aborted before writing/i);

    expect(await readFile(packagePath, "utf8")).toBe(before);
    expect(await exists(path.join(cwd, "amplio.json"))).toBe(false);
    expect(await exists(path.join(cwd, "telemetry"))).toBe(false);
  });

  it("initializes only runtime, Event, sink, and supported detected Plugin paths", async () => {
    const cwd = await makeProject({
      "@useamplio/amplio": "0.1.0-alpha.16",
      hono: "^4.7.4",
      zod: "^3.24.2",
    });
    await mkdir(path.join(cwd, "src"));
    await writeFile(
      path.join(cwd, "src/app.ts"),
      'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
    );
    await runInit({ cwd, yes: true, skipInstall: true });

    for (const relative of [
      "amplio.json",
      "telemetry/runtime.ts",
      "telemetry/sinks/console.ts",
      "telemetry/events/http-request.ts",
      "telemetry/plugins/hono.ts",
    ]) {
      expect(await exists(path.join(cwd, relative)), relative).toBe(true);
    }
    for (const retired of [
      "components.json",
      "telemetry/components",
      "telemetry/workloads",
      "telemetry/middleware",
      "telemetry/integrations",
    ]) {
      expect(await exists(path.join(cwd, retired)), retired).toBe(false);
    }
  });

  it("add event creates an editable duration root with Plugin markers", async () => {
    const cwd = await makeProject();
    await runInit({ cwd, skipInstall: true });
    await runAddEvent("order.placed", { cwd });

    const eventPath = path.join(cwd, "telemetry/events/order-placed.ts");
    const source = await readFile(eventPath, "utf8");
    expect(source).toContain('id: "order.placed"');
    expect(source).toContain("export const OrderPlaced = event(");
    expect(source).toContain("// amplio:plugin-imports");
    expect(source).toContain("// amplio:plugins");
    expect(source).not.toMatch(/defineFact|defineOperation|defineWorkload/);

    const before = source;
    await runAddEvent("order.placed", { cwd });
    expect(await readFile(eventPath, "utf8")).toBe(before);
  });

  it("add sink and resource enricher wire the runtime without semantic-field transforms", async () => {
    const cwd = await makeProject();
    await runInit({ cwd, skipInstall: true });
    await runAddSink("json", { cwd });
    await runAddEnricher("service-metadata", { cwd });

    const runtime = await readFile(
      path.join(cwd, "telemetry/runtime.ts"),
      "utf8",
    );
    expect(runtime).toContain('from "./sinks/json.js"');
    expect(runtime).toMatch(/sinks:\s*\[[^\]]*jsonFileSink\(\)/);
    expect(runtime).toContain('from "./enrichers/service-metadata.js"');
    expect(runtime).toMatch(/enrichers:\s*\[[^\]]*serviceMetadata/);
    const enricher = await readFile(
      path.join(cwd, "telemetry/enrichers/service-metadata.ts"),
      "utf8",
    );
    expect(enricher).toContain('"deployment.version"');
    expect(enricher).not.toMatch(/LogRecord|record\.http|record\.event/);
    expect(await readFile(path.join(cwd, ".gitignore"), "utf8")).toContain(
      "amplio*.jsonl",
    );
  });

  it("add plugin hono --source-only copies a boundary recipe under plugins", async () => {
    const cwd = await makeProject({ hono: "^4.7.4" });
    await runInit({ cwd, skipInstall: true });
    await runAddPlugin("hono", { cwd, sourceOnly: true });
    expect(await exists(path.join(cwd, "telemetry/plugins/hono.ts"))).toBe(
      true,
    );
    expect(
      await exists(path.join(cwd, "telemetry/events/http-request.ts")),
    ).toBe(true);
    expect(await exists(path.join(cwd, "telemetry/runtime.ts"))).toBe(true);
    expect(await exists(path.join(cwd, "telemetry/middleware/hono.ts"))).toBe(
      false,
    );
  });
});
