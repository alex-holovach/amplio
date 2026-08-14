import type { AmplioConfig, SamplingConfig } from "./types.js";
import { logger, type LoggerFacade } from "./logger.js";
import { resetCompiledRedactForTests, setCompiledRedactFromConfig } from "./redact.js";
import { resetUseLoggerOutsideScopeWarningForTests } from "./context.js";
import { getGlobalState } from "./global-state.js";
import {
  clearRuntimeConfig,
  getRuntimeConfig,
  installRuntimeConfig,
  resolveRuntimeConfig,
} from "./runtime-config.js";

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
  if (!installRuntimeConfig(config)) return logger;
  setCompiledRedactFromConfig(config.redact);
  getGlobalState().alwaysSample = computeAlwaysSample(config.sampling);

  return logger;
}

export function getConfig(): AmplioConfig {
  return getRuntimeConfig();
}

export function isInitialized(): boolean {
  return getGlobalState().activeConfig !== null;
}

export function resolveConfig(): AmplioConfig {
  return resolveRuntimeConfig();
}

export function resetEmitBeforeInitWarningForTests(): void {
  // Public test hook; emit-before-init warns on every drop in development.
}

export function resetConfigForTests(): void {
  const state = getGlobalState();
  clearRuntimeConfig();
  state.alwaysSample = true;
  resetUseLoggerOutsideScopeWarningForTests();
  resetCompiledRedactForTests();
}
