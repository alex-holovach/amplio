import type { LogRecord, Sink } from "./types.js";

export function runSinksSync(sinks: Sink[], record: LogRecord): void {
  for (const sink of sinks) {
    try {
      const result = sink(record);
      if (result instanceof Promise) {
        void result.catch(() => {});
      }
    } catch {
      // Sync sink failure must not abort emit or skip later sinks.
    }
  }
}

export async function runSinks(sinks: Sink[], record: LogRecord): Promise<void> {
  for (const sink of sinks) {
    const result = sink(record);
    if (result instanceof Promise) {
      await result;
    }
  }
}
