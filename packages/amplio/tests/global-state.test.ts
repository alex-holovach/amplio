import { beforeEach, describe, expect, it } from "vitest";
import { getGlobalState, getGlobalStateKey } from "../src/global-state.js";
import { init, isInitialized, resetConfigForTests } from "../src/legacy.js";

beforeEach(() => {
  resetConfigForTests();
});

describe("global state", () => {
  it("shares init config via globalThis across module copies", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    const key = getGlobalStateKey();
    const shared = (globalThis as Record<symbol, ReturnType<typeof getGlobalState>>)[key];

    expect(shared).toBe(getGlobalState());
    expect(shared.activeConfig?.service).toBe("api");
    expect(shared.activeConfig?.env).toBe("test");
    expect(isInitialized()).toBe(true);
  });

  it("resetConfigForTests clears shared activeConfig", () => {
    const { sink } = capture();
    init({ service: "api", env: "test", sinks: [sink] });

    resetConfigForTests();

    const shared = getGlobalState();
    expect(shared.activeConfig).toBeNull();
    expect(isInitialized()).toBe(false);
  });

  it("reuses a pre-existing global state object instead of clobbering it", () => {
    const key = getGlobalStateKey();
    const prior = getGlobalState();
    const sentinel = {
      activeConfig: { service: "sentinel", env: "test", sinks: [() => {}] },
      alwaysSample: false,
      storage: prior.storage,
      warnedUseLoggerOutsideScope: true,
      activeCompiled: undefined as ReturnType<typeof getGlobalState>["activeCompiled"],
      pendingAsyncSinks: new Set<Promise<void>>(),
    };
    (globalThis as Record<symbol, unknown>)[key] = sentinel;

    expect(getGlobalState()).toBe(sentinel);
    expect(getGlobalState().activeConfig?.service).toBe("sentinel");
    expect(getGlobalState().alwaysSample).toBe(false);
    expect(getGlobalState().warnedUseLoggerOutsideScope).toBe(true);

    (globalThis as Record<symbol, unknown>)[key] = prior;
    resetConfigForTests();
  });
});

function capture(): { sink: (record: unknown) => void } {
  return {
    sink: () => {},
  };
}
