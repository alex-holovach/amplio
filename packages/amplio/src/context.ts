import { isDevelopment } from "./env.js";
import { getGlobalState } from "./global-state.js";
import { getContextNoopLogger } from "./noop-logger.js";
import type { Logger } from "./types.js";

export function resetUseLoggerOutsideScopeWarningForTests(): void {
  getGlobalState().warnedUseLoggerOutsideScope = false;
}

export function hasAmbientLogger(): boolean {
  return getGlobalState().storage.getStore() !== undefined;
}

export function runWithLogger<T>(logger: Logger, fn: () => T): T {
  return getGlobalState().storage.run(logger, fn);
}

export function useLogger(): Logger {
  const state = getGlobalState();
  const store = state.storage.getStore();
  if (store === undefined) {
    if (isDevelopment() && !state.warnedUseLoggerOutsideScope) {
      state.warnedUseLoggerOutsideScope = true;
      console.warn(
        "[amplio] useLogger() called outside runWithLogger(); fields will be dropped. Establish request scope with middleware (runWithLogger), or use the logger facade for one-shot scripts.",
      );
    }
    return getContextNoopLogger();
  }
  return store;
}
