import type { AmplioConfig, SamplingConfig } from "./types.js";
import { logger, type LoggerFacade } from "./logger.js";
import { resetCompiledRedactForTests, setCompiledRedactFromConfig } from "./redact.js";
import { resetPendingSinksForTests } from "./sinks.js";
import { resetUseLoggerOutsideScopeWarningForTests } from "./context.js";

let activeConfig: AmplioConfig | null = null;
let alwaysSample = true;
let warnedEmitBeforeInit = false;

const computeAlwaysSample = (sampling?: SamplingConfig): boolean => {
  if (!sampling) {
    return true;
  }
  const keep = sampling.keep;
  if ((!keep || keep.length === 0) && (sampling.rate ?? 1) >= 1) {
    return true;
  }
  return false;
};

export function resolveAlwaysSample(): boolean {
  return alwaysSample;
}

export function init(config: AmplioConfig): LoggerFacade {
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
    ...(config.strict !== undefined ? { strict: config.strict } : {}),
  };
  setCompiledRedactFromConfig(config.redact);
  alwaysSample = computeAlwaysSample(config.sampling);

  return logger;
}

export function getConfig(): AmplioConfig {
  if (!activeConfig) {
    throw new Error("amplio is not initialized — call init() first");
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

export function isInitialized(): boolean {
  return activeConfig !== null;
}

export function resolveConfig(): AmplioConfig {
  return activeConfig ?? { service: "", env: "", sinks: [] };
}

export function warnEmitBeforeInitOnce(warn: () => void): void {
  if (warnedEmitBeforeInit) {
    return;
  }
  warnedEmitBeforeInit = true;
  warn();
}

export function resetEmitBeforeInitWarningForTests(): void {
  warnedEmitBeforeInit = false;
}

export function resetConfigForTests(): void {
  activeConfig = null;
  alwaysSample = true;
  warnedEmitBeforeInit = false;
  resetUseLoggerOutsideScopeWarningForTests();
  resetCompiledRedactForTests();
  resetPendingSinksForTests();
}
