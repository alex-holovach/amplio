import {
  beginNestedEvent,
  openRootEvent,
  observeNestedEvent,
  recordNestedEvent,
  snapshotEventTree,
  type EventDefinition,
  type EventScope,
  type EventFromTree,
  type EventInput,
  type ObservationHandle,
  type EventProjectors,
  type EventTree,
} from "./event.js";
import type { DeepPartial } from "./semantic-types.js";

type AnyFunction = (...args: any[]) => any;
type PluginEvent<Events extends EventTree> = Extract<
  EventFromTree<Events>,
  EventDefinition
>;
type EventByTiming<E, Timing extends "instant" | "duration"> =
  E extends EventDefinition
    ? E["timing"] extends Timing
      ? E
      : never
    : never;
type InstantPluginEvent<Events extends EventTree> = EventByTiming<
  PluginEvent<Events>,
  "instant"
>;
type DurationPluginEvent<Events extends EventTree> = EventByTiming<
  PluginEvent<Events>,
  "duration"
>;

export interface PluginTools<Events extends EventTree> {
  readonly events: Events;
  record<E extends InstantPluginEvent<Events>>(
    definition: E,
    value: EventInput<E>,
  ): void;
  observe<E extends DurationPluginEvent<Events>, F extends AnyFunction>(
    definition: E,
    fn: F,
    projectors?: EventProjectors<F, EventInput<E>>,
  ): F;
  begin<E extends DurationPluginEvent<Events>>(
    definition: E,
    input?: DeepPartial<EventInput<E>>,
  ): ObservationHandle<EventInput<E>>;
}

export type Plugin<
  Events extends EventTree,
  Instrumenter extends AnyFunction,
> = Instrumenter & { readonly events: Events };

export type { EventScope, ObservationHandle } from "./event.js";

export function openEvent<
  E extends EventDefinition & { readonly timing: "duration" },
>(definition: E, input?: DeepPartial<EventInput<E>>): EventScope<E> {
  return openRootEvent(definition, input);
}

export function plugin<
  const Id extends string,
  const Events extends EventTree,
  Instrumenter extends AnyFunction,
>(options: {
  id: Id;
  events: Events;
  instrument(tools: PluginTools<Events>): Instrumenter;
}): Plugin<Events, Instrumenter> {
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(options.id)) {
    throw new Error("plugin id must be lowercase kebab-case");
  }

  const events = snapshotEventTree(options.events) as Events;
  const instrumenter = options.instrument({
    events,
    record: recordNestedEvent,
    observe: observeNestedEvent,
    begin: beginNestedEvent,
  });
  if (typeof instrumenter !== "function") {
    throw new Error(`plugin "${options.id}" instrument() must return a function`);
  }

  Object.defineProperty(instrumenter, "events", {
    value: events,
    enumerable: true,
    writable: false,
    configurable: false,
  });
  return instrumenter as Plugin<Events, Instrumenter>;
}
