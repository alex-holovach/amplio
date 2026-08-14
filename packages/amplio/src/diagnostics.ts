import { AsyncLocalStorage } from "node:async_hooks";
import { isDevelopment } from "./env.js";
import type { RuntimeDiagnostic } from "./semantic-types.js";

interface DiagnosticState {
  readonly storage: AsyncLocalStorage<boolean>;
  readonly warned: Map<string, number>;
  readonly activeCallbacks: WeakSet<Function>;
}

const DIAGNOSTIC_STATE_KEY = Symbol.for("amplio.diagnostic-state.v2");
type GlobalWithDiagnosticState = typeof globalThis & {
  [DIAGNOSTIC_STATE_KEY]?: DiagnosticState;
};

const state = ((globalThis as GlobalWithDiagnosticState)[
  DIAGNOSTIC_STATE_KEY
] ??= {
  storage: new AsyncLocalStorage<boolean>(),
  warned: new Map(),
  activeCallbacks: new WeakSet<Function>(),
});

if (!(state.warned instanceof Map)) {
  (state as { warned: Map<string, number> }).warned = new Map();
}
if (!(state.activeCallbacks instanceof WeakSet)) {
  (state as { activeCallbacks: WeakSet<Function> }).activeCallbacks =
    new WeakSet<Function>();
}

export const isDiagnosticContext = (): boolean =>
  state.storage.getStore() === true;

export const reportRuntimeDiagnostic = (
  callback: ((diagnostic: RuntimeDiagnostic) => unknown) | undefined,
  diagnostic: RuntimeDiagnostic,
): void => {
  if (!callback) {
    try {
      if (!isDevelopment()) return;
      const key = `${diagnostic.code}:${diagnostic.event ?? ""}`;
      const now = Date.now();
      const last = state.warned.get(key) ?? 0;
      if (now - last < 60_000) return;
      if (state.warned.size >= 128) state.warned.clear();
      state.warned.set(key, now);
      console.warn(
        `[amplio] ${diagnostic.code}${diagnostic.event ? ` (${diagnostic.event})` : ""}`,
      );
    } catch {
      // Development diagnostics are out-of-band and never affect app work.
    }
    return;
  }
  if (state.activeCallbacks.has(callback)) return;
  state.activeCallbacks.add(callback);
  let pending = false;
  try {
    const result = state.storage.run(true, () =>
      callback(Object.freeze(diagnostic)),
    );
    if (
      result !== null &&
      (typeof result === "object" || typeof result === "function")
    ) {
      let then: unknown;
      try {
        then = (result as { readonly then?: unknown }).then;
      } catch {
        then = undefined;
      }
      if (typeof then === "function") {
        pending = true;
        void Promise.resolve(result)
          .catch(() => undefined)
          .then(() => {
            state.activeCallbacks.delete(callback);
          });
      }
    }
  } catch {
    // Diagnostics are out-of-band and can never replace application behavior.
  } finally {
    if (!pending) state.activeCallbacks.delete(callback);
  }
};
