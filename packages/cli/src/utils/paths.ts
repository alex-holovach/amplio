import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Candidate locations for the bundled registry (published package + monorepo layouts). */
export function bundledRegistryCandidates(): string[] {
  return [
    // Published / package-local: packages/cli/registry (next to dist/)
    path.resolve(moduleDir, "../registry/registry.json"),
    // From dist/ in monorepo checkout without copy: repo root registry/
    path.resolve(moduleDir, "../../../registry/registry.json"),
    // From src/utils during vitest: repo root registry/
    path.resolve(moduleDir, "../../../../registry/registry.json"),
  ];
}

export function resolveBundledRegistryPath(): string {
  for (const candidate of bundledRegistryCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return bundledRegistryCandidates()[0]!;
}

export function resolveProjectPaths(cwd: string, telemetryDir = "telemetry") {
  const root = path.resolve(cwd);
  const telemetry = path.join(root, telemetryDir);
  return {
    root,
    telemetry,
    events: path.join(telemetry, "events"),
    plugins: path.join(telemetry, "plugins"),
    sinks: path.join(telemetry, "sinks"),
    enrichers: path.join(telemetry, "enrichers"),
    runtime: path.join(telemetry, "runtime.ts"),
    config: path.join(root, "amplio.json"),
  };
}
