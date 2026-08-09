import { isDevelopment } from "./env.js";
import { flush } from "./sinks.js";

export interface ScheduleFlushOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

let afterFn: ((task: () => unknown) => void) | undefined;
const nextServerSpec = "next/server";
void import(nextServerSpec)
  .then((m) => {
    const a = (m as { after?: unknown }).after;
    if (typeof a === "function") {
      afterFn = a as typeof afterFn;
    }
  })
  .catch(() => {});

let warnedNoWaitUntil = false;

export function scheduleFlush(options?: ScheduleFlushOptions): void {
  if (options?.waitUntil) {
    options.waitUntil(flush());
    return;
  }

  if (afterFn) {
    afterFn(() => flush());
    return;
  }

  void flush();

  if (isDevelopment() && !warnedNoWaitUntil) {
    warnedNoWaitUntil = true;
    console.warn(
      "[amplio] async sinks may be cut off without waitUntil/after; pass waitUntil to scheduleFlush or call flush()",
    );
  }
}

export function resetScheduleFlushWarningForTests(): void {
  warnedNoWaitUntil = false;
}
