export function renderLoggerTemplate(service = "my-app", doctorCommand = "npx @useamplio/cli@alpha doctor"): string {
  return `// Import this module for side effects before any request handling
// (e.g. \`import "./telemetry/logger"\` or via Next.js instrumentation.ts).
// emit() before init() is a silent no-op (dev builds warn once).
// Run \`${doctorCommand}\` to verify wiring.
import { init, logger } from "@useamplio/amplio";
import type { LogRecord, Sink } from "@useamplio/amplio";

const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};

init({
  service: "${service}",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
  // Canonical sampling config — keep all errors, sample 10% of the rest:
  // sampling: { rate: 0.1, keep: [{ field: "success", equals: false }, { field: "status", gte: 400 }] },
  // see @useamplio/amplio README ## Sampling
  sinks: [consoleJsonSink],
});

export { logger };
`;
}

export function renderAmplioConfig(options: {
  registry?: string;
  packageManager?: string;
  typescript?: boolean;
}): string {
  const config: Record<string, unknown> = {
    telemetryDir: "telemetry",
    typescript: options.typescript ?? true,
    packageManager: options.packageManager ?? "pnpm",
  };

  if (options.registry) {
    config.registry = options.registry;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

export function renderInstrumentationTemplate(loggerImportPath: string): string {
  return `// Next.js instrumentation hook - runs once when the server boots.
// Importing telemetry/logger here runs amplio init() before any request;
// without it, emit() calls are silent no-ops.
export async function register() {
  // Next also compiles this file for the Edge runtime. telemetry/ may pull in
  // node: builtins (e.g. the JSON sink uses node:fs), so only load it on the
  // Node.js runtime — otherwise Turbopack/webpack warn on every compile.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("${loggerImportPath}");
  }
}
`;
}
