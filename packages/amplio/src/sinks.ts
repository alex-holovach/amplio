import { isDevelopment } from "./env.js";
import { getGlobalState } from "./global-state.js";
import type { LogRecord, Sink } from "./types.js";

function trackAsyncSink(promise: Promise<unknown>): void {
  const pendingAsyncSinks = getGlobalState().pendingAsyncSinks;
  const tracked = promise
    .catch((error) => {
      if (isDevelopment()) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[amplio] async sink failed: ${message}`);
      }
    })
    .then(() => undefined);

  pendingAsyncSinks.add(tracked);
  void tracked.finally(() => {
    pendingAsyncSinks.delete(tracked);
  });
}

export function runSinksSync(sinks: Sink[], record: LogRecord): void {
  for (const sink of sinks) {
    try {
      const result = sink(record);
      if (result instanceof Promise) {
        trackAsyncSink(result);
      }
    } catch {
      // Sync sink failure must not abort emit or skip later sinks.
    }
  }
}

export async function runSinks(sinks: Sink[], record: LogRecord): Promise<void> {
  for (const sink of sinks) {
    try {
      const result = sink(record);
      if (result instanceof Promise) {
        await result;
      }
    } catch (error) {
      if (isDevelopment()) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[amplio] async sink failed: ${message}`);
      }
    }
  }
}

export async function flush(): Promise<void> {
  const pending = [...getGlobalState().pendingAsyncSinks];
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
}

export function resetPendingSinksForTests(): void {
  getGlobalState().pendingAsyncSinks.clear();
}
