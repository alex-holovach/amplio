import { isDevelopment } from "./env.js";
import { getGlobalState } from "./global-state.js";
import { flush } from "./sinks.js";

export interface ScheduleFlushOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
}

// Runtime probe for Next's after(). The specifier must stay out of static
// analysis (non-Next apps cannot resolve "next/server" at bundle time), and
// webpackIgnore/vite-ignore stop webpack's "Critical dependency: the request
// of a dependency is an expression" warning on every `next build`.
// The result and the in-flight promise live on the shared global state so
// Turbopack's separate module graphs probe once and agree on the answer.
const nextServerSpec = "next/server";

function probeNextAfter(): Promise<void> {
  const state = getGlobalState();
  if (state.nextAfterProbe) {
    return state.nextAfterProbe;
  }
  state.nextAfterProbe = import(/* webpackIgnore: true */ /* @vite-ignore */ nextServerSpec)
    .then((m) => {
      const a = (m as { after?: unknown }).after;
      state.nextAfter =
        typeof a === "function" ? (a as (task: () => unknown) => void) : null;
    })
    .catch(() => {
      state.nextAfter = null;
    });
  return state.nextAfterProbe;
}

void probeNextAfter();

function flushInlineAndMaybeWarn(): void {
  const state = getGlobalState();
  // Only a real risk when async sink deliveries are actually pending —
  // all-sync sink setups (console + JSONL) have nothing to cut off.
  const hasPendingAsyncSinks = state.pendingAsyncSinks.size > 0;
  void flush();

  if (isDevelopment() && hasPendingAsyncSinks && !state.warnedNoWaitUntil) {
    state.warnedNoWaitUntil = true;
    console.warn(
      "[amplio] async sinks may be cut off without waitUntil/after; pass waitUntil to scheduleFlush or call flush()",
    );
  }
}

export function scheduleFlush(options?: ScheduleFlushOptions): void {
  if (options?.waitUntil) {
    options.waitUntil(flush());
    return;
  }

  const state = getGlobalState();
  if (state.nextAfter) {
    state.nextAfter(() => flush());
    return;
  }

  if (state.nextAfter === undefined) {
    // Probe still in flight (first request can beat the dynamic import) —
    // defer the decision instead of warning prematurely. ALS context flows
    // through the promise chain, so after() still sees the request scope.
    void probeNextAfter().then(() => {
      const resolved = getGlobalState();
      if (resolved.nextAfter) {
        try {
          resolved.nextAfter(() => flush());
          return;
        } catch {
          // after() outside a request scope — fall through to inline flush.
        }
      }
      flushInlineAndMaybeWarn();
    });
    return;
  }

  flushInlineAndMaybeWarn();
}

export function resetScheduleFlushWarningForTests(): void {
  getGlobalState().warnedNoWaitUntil = false;
}
