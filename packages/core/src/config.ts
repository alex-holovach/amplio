import type { LogcnConfig } from "./types.js";
import { logger, type LoggerFacade } from "./logger.js";

let activeConfig: LogcnConfig | null = null;

export function init(config: LogcnConfig): LoggerFacade {
  const service = config.service?.trim();
  const env = config.env?.trim();
  if (!service) {
    throw new Error("init(): service is required");
  }
  if (!env) {
    throw new Error("init(): env is required");
  }
  if (!Array.isArray(config.sinks) || config.sinks.length === 0) {
    throw new Error("init(): at least one sink is required");
  }

  activeConfig = {
    service,
    env,
    sinks: [...config.sinks],
    ...(config.enrichers ? { enrichers: [...config.enrichers] } : {}),
    ...(config.sampling
      ? {
          sampling: {
            ...config.sampling,
            ...(config.sampling.keep
              ? { keep: [...config.sampling.keep] }
              : {}),
          },
        }
      : {}),
    ...(config.redact !== undefined ? { redact: config.redact } : {}),
  };

  return logger;
}

export function getConfig(): LogcnConfig {
  if (!activeConfig) {
    throw new Error("logcn is not initialized — call init() first");
  }
  return {
    ...activeConfig,
    sinks: [...activeConfig.sinks],
    ...(activeConfig.enrichers
      ? { enrichers: [...activeConfig.enrichers] }
      : {}),
    ...(activeConfig.sampling
      ? {
          sampling: {
            ...activeConfig.sampling,
            ...(activeConfig.sampling.keep
              ? { keep: [...activeConfig.sampling.keep] }
              : {}),
          },
        }
      : {}),
  };
}

export function resolveConfig(): LogcnConfig {
  return activeConfig ?? { service: "", env: "", sinks: [], enrichers: [] };
}

export function resetConfigForTests(): void {
  activeConfig = null;
}
