import { AsyncLocalStorage } from "node:async_hooks";
import type { Logger } from "./types.js";

const storage = new AsyncLocalStorage<Logger>();

export function runWithLogger<T>(logger: Logger, fn: () => T): T {
  return storage.run(logger, fn);
}

export function useLogger(): Logger | undefined {
  return storage.getStore();
}
