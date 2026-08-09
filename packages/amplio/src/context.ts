import { isDevelopment } from "./env.js";
import { getGlobalState } from "./global-state.js";
import { getContextNoopLogger } from "./noop-logger.js";
import type { Logger } from "./types.js";

let warnedUseLoggerDeprecated = false;

const USE_LOGGER_DEPRECATED_WARNING =
  "[amplio] useLogger() is deprecated and will be removed before 1.0 — use getLogger() (same behavior; renamed because lint tools mistake useLogger for a React hook).";

export function resetUseLoggerOutsideScopeWarningForTests(): void {
  getGlobalState().warnedUseLoggerOutsideScope = false;
}

export function resetUseLoggerDeprecationWarningForTests(): void {
  warnedUseLoggerDeprecated = false;
}

export function hasAmbientLogger(): boolean {
  return getGlobalState().storage.getStore() !== undefined;
}

export function runWithLogger<T>(logger: Logger, fn: () => T): T {
  return getGlobalState().storage.run(logger, fn);
}

export function getLogger(): Logger {
  const state = getGlobalState();
  const store = state.storage.getStore();
  if (store === undefined) {
    if (isDevelopment() && !state.warnedUseLoggerOutsideScope) {
      state.warnedUseLoggerOutsideScope = true;
      console.warn(
        "[amplio] getLogger() called outside runWithLogger(); fields will be dropped. Establish request scope with middleware (runWithLogger), or use the logger facade for one-shot scripts.",
      );
    }
    return getContextNoopLogger();
  }
  return store;
}

export function useLogger(): Logger {
  if (isDevelopment() && !warnedUseLoggerDeprecated) {
    warnedUseLoggerDeprecated = true;
    console.warn(USE_LOGGER_DEPRECATED_WARNING);
  }
  return getLogger();
}
