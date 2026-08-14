import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAddEnricher, runAddSink } from "../src/commands/add.js";

const registry = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../registry/registry.manifest.json",
);

describe("operational recipe activation", () => {
  it("aborts without copied source when an existing runtime cannot be wired", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "amplio-sink-activation-"));
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "sink-app",
          dependencies: { "@useamplio/amplio": "0.1.0-alpha.17" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(cwd, "amplio.json"),
      `${JSON.stringify({ telemetryDir: "telemetry", registry }, null, 2)}\n`,
    );
    await mkdir(path.join(cwd, "telemetry"), { recursive: true });
    const runtimePath = path.join(cwd, "telemetry/runtime.ts");
    await writeFile(runtimePath, "export {};\n");
    const before = await readFile(runtimePath, "utf8");

    await expect(runAddSink("json", { cwd })).rejects.toThrow(
      "runtime.ts cannot be safely wired with sink \"json\"; no files were changed",
    );

    await expect(access(path.join(cwd, "telemetry/sinks/json.ts"))).rejects.toThrow();
    await expect(readFile(runtimePath, "utf8")).resolves.toBe(before);
  });

  it("aborts an enricher without copied source when runtime wiring is unsafe", async () => {
    const cwd = await mkdtemp(
      path.join(tmpdir(), "amplio-enricher-activation-"),
    );
    await writeFile(
      path.join(cwd, "package.json"),
      `${JSON.stringify(
        {
          name: "enricher-app",
          dependencies: { "@useamplio/amplio": "0.1.0-alpha.17" },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(cwd, "amplio.json"),
      `${JSON.stringify({ telemetryDir: "telemetry", registry }, null, 2)}\n`,
    );
    await mkdir(path.join(cwd, "telemetry"), { recursive: true });
    const runtimePath = path.join(cwd, "telemetry/runtime.ts");
    await writeFile(runtimePath, "export {};\n");

    await expect(
      runAddEnricher("service-metadata", { cwd }),
    ).rejects.toThrow(
      'runtime.ts cannot be safely wired with enricher "service-metadata"; no files were changed',
    );
    await expect(
      access(path.join(cwd, "telemetry/enrichers/service-metadata.ts")),
    ).rejects.toThrow();
    await expect(readFile(runtimePath, "utf8")).resolves.toBe("export {};\n");
  });
});
