export { init } from "./semantic-init.js";
export { flush } from "./sinks.js";
export { event } from "./event.js";
export type {
  Event,
  EventDefinition,
  EventInput,
  EventOutput,
  EventProjectors,
  EventRecord,
  Schema,
  SchemaIssue,
  SchemaResult,
  StructuredError,
} from "./event.js";

export type {
  DeliveryOptions,
  EventLimits,
  FlushOptions,
  FlushResult,
  InitOptions,
  JsonPrimitive,
  JsonValue,
  RuntimeDiagnostic,
  Sink,
  SinkRecord,
} from "./semantic-types.js";
