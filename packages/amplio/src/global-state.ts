import { AsyncLocalStorage } from "node:async_hooks";
import type { CompiledRedactConfig } from "./redact.js";
import type { AmplioConfig, Logger } from "./types.js";

const GLOBAL_STATE_KEY = Symbol.for("amplio.state.v1");

export interface AmplioGlobalState {
  activeConfig: AmplioConfig | null;
  alwaysSample: boolean;
  storage: AsyncLocalStorage<Logger>;
  warnedUseLoggerOutsideScope: boolean;
  activeCompiled: CompiledRedactConfig | false | undefined;
  pendingAsyncSinks: Set<Promise<void>>;
}

const createState = (): AmplioGlobalState => ({
  activeConfig: null,
  alwaysSample: true,
  storage: new AsyncLocalStorage<Logger>(),
  warnedUseLoggerOutsideScope: false,
  activeCompiled: undefined,
  pendingAsyncSinks: new Set(),
});

type GlobalWithAmplioState = typeof globalThis & {
  [key: symbol]: AmplioGlobalState | undefined;
};

export function getGlobalState(): AmplioGlobalState {
  const global = globalThis as GlobalWithAmplioState;
  const existing = global[GLOBAL_STATE_KEY];
  if (existing) {
    return existing;
  }
  const state = createState();
  global[GLOBAL_STATE_KEY] = state;
  return state;
}

export function getGlobalStateKey(): symbol {
  return GLOBAL_STATE_KEY;
}
