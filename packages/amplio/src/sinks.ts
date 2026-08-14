import { reportRuntimeDiagnostic } from "./diagnostics.js";
import { getGlobalState } from "./global-state.js";
import type {
  FlushOptions,
  FlushResult,
  AmplioConfig,
  DeliveryOptions,
  LegacySink,
  LogRecord,
  RuntimeDiagnostic,
} from "./semantic-types.js";

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  value !== null &&
  (typeof value === "object" || typeof value === "function") &&
  typeof (value as { then?: unknown }).then === "function";

interface PendingDelivery {
  readonly id: number;
  readonly promise: Promise<{ failed: boolean }>;
  readonly sink?: LegacySink;
  readonly generationId?: number;
  readonly legacyTracked: Promise<void>;
}

interface SinkGeneration {
  readonly id: number;
  readonly sinks: readonly LegacySink[];
  readonly delivery: DeliveryOptions;
  readonly onDiagnostic?: (
    diagnostic: RuntimeDiagnostic,
  ) => void | PromiseLike<void>;
  readonly pending: Set<number>;
  openRoots: number;
  expiresAt?: number;
}

interface DeliveryState {
  nextId: number;
  nextGenerationId: number;
  readonly pending: Map<number, PendingDelivery>;
  pendingBySink: WeakMap<LegacySink, number>;
  activeGeneration?: SinkGeneration;
  readonly retiredGenerations: SinkGeneration[];
}

const DELIVERY_STATE_KEY = Symbol.for("amplio.delivery-state.v2");
type GlobalWithDeliveryState = typeof globalThis & {
  [DELIVERY_STATE_KEY]?: DeliveryState;
};

const getDeliveryState = (): DeliveryState => {
  const global = globalThis as GlobalWithDeliveryState;
  return (global[DELIVERY_STATE_KEY] ??= {
    nextId: 0,
    nextGenerationId: 0,
    pending: new Map(),
    pendingBySink: new WeakMap(),
    retiredGenerations: [],
  });
};

const notify = (
  generation: SinkGeneration | undefined,
  diagnostic: RuntimeDiagnostic,
): void => {
  const callback = generation?.onDiagnostic;
  reportRuntimeDiagnostic(callback, diagnostic);
};

const generationById = (
  state: DeliveryState,
  id: number | undefined,
): SinkGeneration | undefined =>
  id === undefined
    ? undefined
    : state.activeGeneration?.id === id
      ? state.activeGeneration
      : state.retiredGenerations.find((generation) => generation.id === id);

const reportSinkFailure = (generationId?: number): void => {
  const generation = generationById(getDeliveryState(), generationId);
  if (generation) {
    notify(generation, { code: "sink_failed", stage: "delivery" });
  } else {
    reportRuntimeDiagnostic(undefined, {
      code: "sink_failed",
      stage: "delivery",
    });
  }
};

const removePending = (state: DeliveryState, id: number): void => {
  const entry = state.pending.get(id);
  if (!entry || !state.pending.delete(id)) return;
  if (entry.sink) {
    const count = state.pendingBySink.get(entry.sink) ?? 0;
    if (count <= 1) state.pendingBySink.delete(entry.sink);
    else state.pendingBySink.set(entry.sink, count - 1);
  }
  generationById(state, entry.generationId)?.pending.delete(id);
  getGlobalState().pendingAsyncSinks.delete(entry.legacyTracked);
};

const abandonGeneration = (
  state: DeliveryState,
  generation: SinkGeneration,
): void => {
  const abandoned = generation.pending.size;
  for (const id of [...generation.pending]) removePending(state, id);
  if (abandoned > 0) {
    notify(generation, {
      code: "sink_generation_abandoned",
      stage: "delivery",
      count: abandoned,
    });
  }
};

const pruneExpiredGenerations = (
  state: DeliveryState,
  now = Date.now(),
): void => {
  for (
    let index = state.retiredGenerations.length - 1;
    index >= 0;
    index -= 1
  ) {
    const generation = state.retiredGenerations[index]!;
    if (
      generation.openRoots === 0 &&
      generation.expiresAt !== undefined &&
      generation.expiresAt <= now
    ) {
      abandonGeneration(state, generation);
      state.retiredGenerations.splice(index, 1);
    }
  }
};

export function installSinkGeneration(config: AmplioConfig): boolean {
  const state = getDeliveryState();
  pruneExpiredGenerations(state);
  const delivery = config.eventRuntime?.delivery ?? {};
  const maxRetired = delivery.maxRetiredGenerations ?? 4;
  const active = state.activeGeneration;
  if (active) {
    while (state.retiredGenerations.length >= maxRetired) {
      const disposable = state.retiredGenerations.findIndex(
        (generation) =>
          generation.openRoots === 0 && generation.pending.size === 0,
      );
      if (disposable < 0) {
        const proposed: SinkGeneration = {
          id: -1,
          sinks: [],
          delivery,
          onDiagnostic: config.eventRuntime?.onDiagnostic,
          pending: new Set(),
          openRoots: 0,
        };
        notify(proposed, {
          code: "config_generation_limit",
          stage: "configuration",
        });
        return false;
      }
      state.retiredGenerations.splice(disposable, 1);
    }
    active.expiresAt =
      Date.now() + (active.delivery.retiredGenerationTtlMs ?? 30_000);
    state.retiredGenerations.push(active);
  }

  const id = ++state.nextGenerationId;
  config.eventRuntime = {
    ...config.eventRuntime,
    deliveryGenerationId: id,
  };
  state.activeGeneration = {
    id,
    sinks: [...new Set(config.sinks)],
    delivery,
    onDiagnostic: config.eventRuntime.onDiagnostic,
    pending: new Set(),
    openRoots: 0,
  };
  return true;
}

export function retainSinkGeneration(config: AmplioConfig): void {
  const state = getDeliveryState();
  const generation = generationById(
    state,
    config.eventRuntime?.deliveryGenerationId,
  );
  if (generation) generation.openRoots += 1;
}

export function releaseSinkGeneration(config: AmplioConfig): void {
  const state = getDeliveryState();
  const generation = generationById(
    state,
    config.eventRuntime?.deliveryGenerationId,
  );
  if (generation && generation.openRoots > 0) generation.openRoots -= 1;
}

function trackAsyncSink(
  promise: PromiseLike<unknown>,
  sink?: LegacySink,
  generationId?: number,
): void {
  const pendingAsyncSinks = getGlobalState().pendingAsyncSinks;
  const state = getDeliveryState();
  const id = ++state.nextId;
  const tracked = Promise.resolve(promise).then(
    () => ({ failed: false }),
    () => {
      reportSinkFailure(generationId);
      return { failed: true };
    },
  );
  const legacyTracked = tracked.then(() => undefined);

  const entry = { id, promise: tracked, sink, generationId, legacyTracked };
  state.pending.set(id, entry);
  generationById(state, generationId)?.pending.add(id);
  if (sink) {
    state.pendingBySink.set(sink, (state.pendingBySink.get(sink) ?? 0) + 1);
  }
  pendingAsyncSinks.add(legacyTracked);
  void tracked.finally(() => {
    removePending(state, id);
  });
}

export function runSinksSync(
  sinks: LegacySink[],
  record: LogRecord,
  options: {
    maxPendingPerSink?: number;
    onBackpressure?: (sink: LegacySink) => void;
    generationId?: number;
  } = {},
): void {
  const state = getDeliveryState();
  for (const sink of sinks) {
    if (
      options.maxPendingPerSink !== undefined &&
      (state.pendingBySink.get(sink) ?? 0) >= options.maxPendingPerSink
    ) {
      options.onBackpressure?.(sink);
      continue;
    }
    try {
      const result = sink(record);
      if (isPromiseLike(result)) {
        trackAsyncSink(result, sink, options.generationId);
      }
    } catch {
      // Sync sink failure must not abort emit or skip later sinks.
      reportSinkFailure(options.generationId);
    }
  }
}

export async function runSinks(
  sinks: LegacySink[],
  record: LogRecord,
): Promise<void> {
  for (const sink of sinks) {
    try {
      const result = sink(record);
      if (isPromiseLike(result)) {
        await Promise.resolve(result);
      }
    } catch {
      reportSinkFailure();
    }
  }
}

export async function flush(options: FlushOptions = {}): Promise<FlushResult> {
  const state = getDeliveryState();
  pruneExpiredGenerations(state);
  const watermark = state.nextId;
  const deliveries = [...state.pending.values()].filter(
    (entry) => entry.id <= watermark,
  );
  const generations = [
    ...state.retiredGenerations,
    ...(state.activeGeneration ? [state.activeGeneration] : []),
  ];
  const sinks = [...new Set(generations.flatMap(({ sinks }) => sinks))];
  const tasks: Array<Promise<{ failed: boolean }>> = deliveries.map(
    (entry) => entry.promise,
  );

  // Every hook is invoked before the first await so one slow hook cannot stop
  // a later sink from beginning its own drain.
  for (const sink of sinks) {
    if (!sink.flush) continue;
    try {
      const result = sink.flush();
      tasks.push(
        isPromiseLike(result)
          ? Promise.resolve(result).then(
              () => ({ failed: false }),
              () => {
                const generation = generations.find(({ sinks }) =>
                  sinks.includes(sink),
                );
                reportSinkFailure(generation?.id);
                return { failed: true };
              },
            )
          : Promise.resolve({ failed: false }),
      );
    } catch {
      const generation = generations.find(({ sinks }) =>
        sinks.includes(sink),
      );
      reportSinkFailure(generation?.id);
      tasks.push(Promise.resolve({ failed: true }));
    }
  }

  if (tasks.length === 0) {
    return { completed: 0, pending: 0, failures: 0 };
  }

  let completed = 0;
  let failures = 0;
  const observed = tasks.map((task) =>
    task.then((result) => {
      completed += 1;
      if (result.failed) failures += 1;
    }),
  );
  const configuredTimeout =
    getGlobalState().activeConfig?.eventRuntime?.delivery?.flushTimeoutMs ??
    5_000;
  const timeoutMs = Math.max(0, options.timeoutMs ?? configuredTimeout);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(observed),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { completed, pending: tasks.length - completed, failures };
}

export function resetPendingSinksForTests(): void {
  getGlobalState().pendingAsyncSinks.clear();
  const state = getDeliveryState();
  state.pending.clear();
  state.nextId = 0;
  state.nextGenerationId = 0;
  state.pendingBySink = new WeakMap();
  state.activeGeneration = undefined;
  state.retiredGenerations.length = 0;
}
