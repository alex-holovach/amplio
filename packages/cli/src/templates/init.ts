export function renderLoggerTemplate(service = "my-app"): string {
  return `import { init, logger } from "@amplio/core";
import type { LogRecord, Sink } from "@amplio/core";

const consoleJsonSink: Sink = (record: LogRecord) => {
  console.log(JSON.stringify(record));
};

init({
  service: "${service}",
  env: process.env.NODE_ENV ?? "development",
  enrichers: [],
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
    $schema: "https://ui.shadcn.com/schema/registry.json",
    telemetryDir: "telemetry",
    typescript: options.typescript ?? true,
    packageManager: options.packageManager ?? "pnpm",
  };

  if (options.registry) {
    config.registry = options.registry;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}
