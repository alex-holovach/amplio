import { AsyncLocalStorage } from "node:async_hooks";
import { isDevelopment } from "./env.js";
import { getContextNoopLogger } from "./noop-logger.js";
import type { Logger } from "./types.js";

const storage = new AsyncLocalStorage<Logger>();

let warnedUseLoggerOutsideScope = false;

export function resetUseLoggerOutsideScopeWarningForTests(): void {
  warnedUseLoggerOutsideScope = false;
}

export function hasAmbientLogger(): boolean {
  return storage.getStore() !== undefined;
}

export function runWithLogger<T>(logger: Logger, fn: () => T): T {
  return storage.run(logger, fn);
}

export function useLogger(): Logger {
  const store = storage.getStore();
  if (store === undefined) {
    if (isDevelopment() && !warnedUseLoggerOutsideScope) {
      warnedUseLoggerOutsideScope = true;
      console.warn(
        "[amplio] useLogger() called outside runWithLogger(); fields will be dropped. Establish request scope with middleware (runWithLogger), or use the logger facade for one-shot scripts.",
      );
    }
    return getContextNoopLogger();
  }
  return store;
}
