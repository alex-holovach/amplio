import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runAddPlugin } from "../src/commands/add.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { runRemovePlugin } from "../src/commands/plugin-lifecycle.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const registryPath = path.join(repoRoot, "registry/registry.manifest.json");

async function makeProject(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "amplio-ai-sdk-plugin-"));
  await writeFile(
    path.join(cwd, "package.json"),
    `${JSON.stringify(
      {
        name: "ai-sdk-app",
        private: true,
        type: "module",
        dependencies: {
          "@useamplio/amplio": "0.1.0-alpha.17",
          ai: "7.0.65",
          hono: "^4.13.2",
          zod: "^3.25.76",
        },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(
    path.join(cwd, "src/app.ts"),
    'import { Hono } from "hono";\n\nexport const app = new Hono();\n',
  );
  await runInit({ cwd, yes: true, skipInstall: true });
  const configPath = path.join(cwd, "amplio.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
    string,
    unknown
  >;
  config.registry = registryPath;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return cwd;
}

describe("AI SDK Plugin installation", () => {
  it("mounts the Event and registers one native telemetry integration", async () => {
    const cwd = await makeProject();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runAddPlugin("ai-sdk", { cwd, event: "http.request" });

      const pluginPath = path.join(cwd, "telemetry/plugins/ai-sdk.ts");
      await access(pluginPath);
      const eventPath = path.join(cwd, "telemetry/events/http-request.ts");
      const runtimePath = path.join(cwd, "telemetry/runtime.ts");
      const plugin = await readFile(pluginPath, "utf8");
      const root = await readFile(eventPath, "utf8");
      const runtime = await readFile(runtimePath, "utf8");

      expect(plugin).toContain("export const AiSdkPlugin = plugin(");
      expect(plugin).toContain('id: "ai.operation"');
      expect(plugin).toContain("version: 2");
      expect(plugin).toContain("model_family");
      expect(plugin).toContain("MAX_AGGREGATE_COUNT");
      expect(plugin).not.toContain("call_id");
      expect(root).toContain(
        'import { AiSdkPlugin } from "../plugins/ai-sdk.js";',
      );
      expect(root).toContain("ai: AiSdkPlugin.events,");
      expect(runtime).toContain('import { registerTelemetry } from "ai";');
      expect(runtime).toContain(
        'import { AiSdkPlugin } from "./plugins/ai-sdk.js";',
      );
      expect(
        runtime.match(/registerTelemetry\(AiSdkPlugin\(\)\)/g),
      ).toHaveLength(1);

      const config = JSON.parse(
        await readFile(path.join(cwd, "amplio.json"), "utf8"),
      ) as {
        plugins: Record<string, Record<string, unknown>>;
      };
      expect(config.plugins["ai-sdk"]).toMatchObject({
        recipeVersion: "1.1.0",
        event: "http.request",
        branch: "ai",
        source: "telemetry/plugins/ai-sdk.ts",
        compositionRoot: "telemetry/runtime.ts",
        peers: { ai: ">=7 <8" },
        events: [
          {
            id: "ai.operation",
            version: 2,
            semanticDigest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
          },
        ],
        nativeTransform: {
          version: 2,
          digest: expect.stringMatching(/^sha256-[a-f0-9]{64}$/),
        },
      });
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

      const beforeRerun = await Promise.all(
        [pluginPath, eventPath, runtimePath, path.join(cwd, "amplio.json")].map(
          (file) => readFile(file, "utf8"),
        ),
      );
      await runAddPlugin("ai-sdk", { cwd, event: "http.request" });
      await expect(
        Promise.all(
          [
            pluginPath,
            eventPath,
            runtimePath,
            path.join(cwd, "amplio.json"),
          ].map((file) => readFile(file, "utf8")),
        ),
      ).resolves.toEqual(beforeRerun);

      await runRemovePlugin("ai-sdk", { cwd });
      await expect(access(pluginPath)).rejects.toThrow();
      expect(await readFile(eventPath, "utf8")).not.toContain("AiSdkPlugin");
      expect(await readFile(runtimePath, "utf8")).not.toContain(
        "registerTelemetry",
      );
      const packageJson = JSON.parse(
        await readFile(path.join(cwd, "package.json"), "utf8"),
      ) as { dependencies: Record<string, string> };
      expect(packageJson.dependencies.ai).toBe("7.0.65");
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  it("ignores comment and string decoys and doctor requires the live registration", async () => {
    const cwd = await makeProject();
    const runtimePath = path.join(cwd, "telemetry/runtime.ts");
    const initial = await readFile(runtimePath, "utf8");
    await writeFile(
      runtimePath,
      `${initial}\n// registerTelemetry(AiSdkPlugin());\nconst telemetryDecoy = "registerTelemetry(AiSdkPlugin())";\n`,
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await runAddPlugin("ai-sdk", { cwd, event: "http.request" });
      const installed = await readFile(runtimePath, "utf8");
      expect(installed).toContain(
        'const telemetryDecoy = "registerTelemetry(AiSdkPlugin())";',
      );
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(0);

      await writeFile(
        runtimePath,
        installed.replace(/^registerTelemetry\(AiSdkPlugin\(\)\);$/m, ""),
      );
      await expect(runDoctor({ cwd, strict: true })).resolves.toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
