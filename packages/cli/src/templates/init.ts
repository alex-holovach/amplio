export function renderRuntimeTemplate(
  service = "my-app",
  doctorCommand = "npx @useamplio/cli@alpha doctor",
): string {
  return `// Import this module for side effects before any request handling
// (e.g. \`import "./telemetry/runtime.js"\` or via Next.js instrumentation.ts).
// Run \`${doctorCommand}\` to check the tracked telemetry layout.
import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console.js";

init({
  service: "${service}",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  // Canonical sampling config — keep all errors, sample 10% of the rest:
  // sampling: { rate: 0.1, keep: [{ field: "success", equals: false }, { field: "http.status", gte: 400 }] },
  // see @useamplio/amplio README ## Sampling
  sinks: [consoleSink],
});
`;
}

export function renderConsoleSinkTemplate(): string {
  return `import type { Sink } from "@useamplio/amplio";

const createJsonReplacer = () => {
  const ancestors: object[] = [];
  return function (this: object, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") {
      return value.toString();
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) {
      return "[Circular]";
    }
    ancestors.push(value);
    return value;
  };
};

export const consoleSink: Sink = (record) => {
  console.log(JSON.stringify(record, createJsonReplacer()));
};
`;
}

export function renderAmplioConfig(options: {
  registry?: string;
  packageManager?: string;
  telemetryDir?: string;
}): string {
  const config: Record<string, unknown> = {
    telemetryDir: options.telemetryDir ?? "telemetry",
    packageManager: options.packageManager ?? "pnpm",
  };

  if (options.registry) {
    config.registry = options.registry;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderInstrumentationTemplate(
  runtimeImportPath: string,
): string {
  return `// Next.js instrumentation hook - runs once when the server boots.
// Importing telemetry/runtime here runs amplio init() before any request.
export async function register() {
  // Next also compiles this file for the Edge runtime. telemetry/ may pull in
  // node: builtins (e.g. the JSON sink uses node:fs), so only load it on the
  // Node.js runtime — otherwise Turbopack/webpack warn on every compile.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("${runtimeImportPath}");
  }
}
`;
}
