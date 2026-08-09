import type { AmplioConfig, SamplingConfig } from "./types.js";
import { logger, type LoggerFacade } from "./logger.js";
import { resetCompiledRedactForTests, setCompiledRedactFromConfig } from "./redact.js";
import { resetPendingSinksForTests } from "./sinks.js";
import { resetUseLoggerOutsideScopeWarningForTests } from "./context.js";
import { getGlobalState } from "./global-state.js";

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
  return getGlobalState().alwaysSample;
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

  const state = getGlobalState();
  state.activeConfig = {
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
    ...(config.canonicalKeyOnly !== undefined
      ? { canonicalKeyOnly: config.canonicalKeyOnly }
      : {}),
  };
  setCompiledRedactFromConfig(config.redact);
  state.alwaysSample = computeAlwaysSample(config.sampling);

  return logger;
}

export function getConfig(): AmplioConfig {
  const activeConfig = getGlobalState().activeConfig;
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
  return getGlobalState().activeConfig !== null;
}

export function resolveConfig(): AmplioConfig {
  return getGlobalState().activeConfig ?? { service: "", env: "", sinks: [] };
}

export function resetEmitBeforeInitWarningForTests(): void {
  // Public test hook; emit-before-init warns on every drop in development.
}

export function resetConfigForTests(): void {
  const state = getGlobalState();
  state.activeConfig = null;
  state.alwaysSample = true;
  resetUseLoggerOutsideScopeWarningForTests();
  resetCompiledRedactForTests();
  resetPendingSinksForTests();
}
