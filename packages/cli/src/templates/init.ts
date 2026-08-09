export function renderLoggerTemplate(service = "my-app"): string {
  return `import { init, logger } from "@useamplio/amplio";
import type { LogRecord, Sink } from "@useamplio/amplio";

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
    telemetryDir: "telemetry",
    typescript: options.typescript ?? true,
    packageManager: options.packageManager ?? "pnpm",
  };

  if (options.registry) {
    config.registry = options.registry;
  }

  return `${JSON.stringify(config, null, 2)}\n`;
}

/** shadcn components.json so @useamplio/* installs into telemetry/ */
export function renderComponentsJson(registryUrl: string): string {
  const config = {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "new-york",
    rsc: false,
    tsx: true,
    tailwind: {
      config: "",
      css: "",
      baseColor: "neutral",
      cssVariables: true,
    },
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    registries: {
      "@useamplio": registryUrl,
    },
  };

  return `${JSON.stringify(config, null, 2)}\n`;
}
