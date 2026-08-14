# Technical specification — Amplio Event runtime

This specification defines the executable Event/Plugin contract. It supersedes the alpha Logger,
fact, operation, component, workload, integration, and middleware model. Temporary mutable-builder
compatibility under `@useamplio/amplio/legacy` is outside this design.

Normative terms `MUST`, `SHOULD`, and `MAY` have their usual requirements meanings.

## 1. Public model

Amplio has two customer-facing semantic concepts:

- **Event** — a typed semantic node. A root Event owns one complete unit of work and the declared
  output tree. A nested Event represents one bounded semantic observation.
- **Plugin** — editable open code that connects a framework, provider, SDK, or local subsystem to
  exact Event definitions at a native seam.

Boundary, contributor, seam, tree, observation, and sink describe roles or configuration. They are
not additional semantic node types.

## 2. Public package surfaces

### 2.1 Main

`@useamplio/amplio` exports:

```ts
export { event, flush, init };
export type {
  Event,
  EventRecord,
  FlushResult,
  InitOptions,
  JsonValue,
  Schema,
  Sink,
  SinkRecord,
};
```

The main entrypoint MUST NOT export a Logger, mutable Event builder, ambient accessor,
`defineFact`, `defineOperation`, `defineComponent`, `defineWorkload`, placement wrappers, vendor
types, or global `record`/`observe` functions.

`init(options)` configures by side effect and returns `void`.

### 2.2 Plugin authoring

`@useamplio/amplio/plugin` exports:

```ts
export { openEvent, plugin };
export type { EventScope, Plugin, PluginTools };
```

This subpath is for editable files under `telemetry/plugins/`, not business call sites.

### 2.3 Testing

`@useamplio/amplio/testing` MAY export `createTestSink`, `assertEvent`, and definition-aware helpers.
Testing helpers may throw explicit assertion failures. Production wrappers MUST NOT infer strictness
from `NODE_ENV` or throw telemetry validation errors through application work.

## 3. Event definition contract

### 3.1 Schema and JSON types

Event semantic input and output are JSON object records. Scalar semantics use a named field such as
`{ value }`.

Core accepts the Standard Schema-compatible structural contract:

```ts
type Schema<Input extends JsonObject, Output extends JsonObject> = {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: { readonly input: Input; readonly output: Output };
    validate(
      value: unknown,
    ):
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly SchemaIssue[] }
      | PromiseLike<SchemaResult<Output>>;
  };
};
```

Core MUST NOT depend on Zod or another schema implementation. Generated Events may use a schema
package owned by the host application.

Projectors accept synchronous `DeepPartial<Input>` patches. Nested objects merge, arrays replace,
and later lifecycle patches win. `EventRecord<E>` uses validated `Output`.

V1 finalization is synchronous. A thenable validation result is consumed only to avoid an unhandled
rejection; the affected nested occurrence or root is dropped and `async_schema_unsupported` is
diagnosed without changing application behavior.

### 3.2 `event()`

Conceptually:

```ts
event({
  id,
  version,
  schema,
  timing = "duration",
  cardinality = "single",
  maxDurationMs,
  tree = {},
});
```

Construction MUST validate:

- lowercase dot-separated stable `id`;
- positive integer `version`;
- `timing` equal to `"instant"` or `"duration"`;
- `cardinality` equal to `"single"` or `{ many: { max } }` with a finite positive integer;
- positive finite duration override; and
- a safe declared tree.

Every call produces one opaque process-local identity. The returned definition and its compiled tree
are deeply snapshotted, branded, and frozen.

A duration Event exposes:

```ts
handle<F extends (...args: any[]) => any>(
  fn: F,
  projectors?: EventProjectors<F, EventInput<this>>,
): F;
```

An instant Event does not expose `handle()` and cannot declare children. A root opened through
`handle()` occurs exactly once regardless of its cardinality descriptor.

### 3.3 Definition fidelity

`handle()` and Plugin wrappers MUST preserve:

- `this`, argument order/identity, overloads, callback behavior, and application invocation count;
- synchronous return versus asynchronous return;
- exact returned values and exact thrown values;
- native Promise object identity, fulfillment values, and rejection reasons.

Genuine ECMAScript Promises, including cross-realm Promises, are detected without reading a
user-controlled `.then`; settlement observers are attached through an intrinsic operation and the
original Promise is returned.

Arbitrary thenables are not read, called, assimilated, or advertised as supported. Plugins for
custom thenable APIs MUST use documented native hooks or `begin()`/`end()`.

Projectors are synchronous. A projector throw or returned thenable is isolated, consumed when
necessary, diagnosed, and ignored. A `success` projector returning a non-boolean is ignored and
diagnosed. No instrumentation failure escapes.

## 4. Declared tree

### 4.1 Placement and traversal

Nested plain objects determine record placement:

```ts
tree: {
  auth: BetterAuthPlugin.events,
  payments: {
    requests: StripePlugin.events.requests,
  },
}
```

Event IDs identify schema versions and diagnostics; they do not determine placement.

Traversal reads only own enumerable data properties and MUST reject arrays, symbol keys, accessors,
cycles, proxy failures, non-plain prototypes, `__proto__`, `prototype`, `constructor`, runtime-owned
keys, and values that are not branded Events or plain tree objects.

One Event identity may appear at only one path in a root. Duplicate mounts fail at construction. The
same nested identity may be mounted once in each of several different roots.

### 4.2 Optionality and record typing

All mounted nested Events are optional in traffic:

- an unobserved single Event is omitted;
- an unobserved repeated Event is omitted, not `[]`;
- a plain group with no surviving descendants is pruned.

`EventRecord<E>` recursively represents mounted branches as optional and chooses one object or an
array from the nested Event's cardinality. Duration nodes include runtime timing/outcome fields;
instant nodes do not.

### 4.3 HMR and identity mismatch

Duplicate module evaluation may create two identities with one semantic ID. The runtime diagnoses
the mismatch and MUST NOT attach by ID. Registry source uses one canonical import path per Plugin.

## 5. Plugin authoring contract

### 5.1 `plugin()`

Conceptually:

```ts
plugin({
  id,
  events,
  instrument(tools) {
    return nativeInstrumenter;
  },
});
```

The return value is the native instrumenter with a non-writable, non-configurable `.events`
property. `.events` is a safe, deeply frozen snapshot. The instrumenter closes over those exact Event
values, and roots mount those same values.

The Plugin definition is not an output node. Values inside `.events` are the output definitions.

### 5.2 `PluginTools`

Tools are available only inside `instrument(...)`:

```ts
interface PluginTools<Events extends EventTree> {
  readonly events: Events;
  record<E extends InstantEventFrom<Events>>(
    event: E,
    value: EventInput<E>,
  ): void;
  observe<E extends DurationEventFrom<Events>, F extends AnyFunction>(
    event: E,
    fn: F,
    projectors?: EventProjectors<F, EventInput<E>>,
  ): F;
  begin<E extends DurationEventFrom<Events>>(
    event: E,
    input?: DeepPartial<EventInput<E>>,
  ): ObservationHandle<EventInput<E>>;
}
```

Invalid Event/tool combinations MUST fail typechecking. Tools attach only when the exact definition
is mounted under the active occurrence.

`begin()` reserves order synchronously and returns an idempotent handle:

```ts
interface ObservationHandle<Node> {
  run<T>(fn: () => T): T;
  bind<F extends AnyFunction>(fn: F): F;
  update(value: DeepPartial<Node>): void;
  end(value?: DeepPartial<Node>, options?: { success?: boolean }): void;
  fail(error: unknown, value?: DeepPartial<Node>): void;
  cancel(reasonCode?: string): void;
}
```

`end`, `fail`, and `cancel` settle at most once. Cancellation records a stable non-sensitive code;
it never cancels or throws into provider code.

Outside an active declaring Event, Plugin calls execute provider code normally and perform no
semantic write. Development diagnostics distinguish no active root, undeclared Event, closed root,
duplicates, overflow, schema failure, and projection failure.

### 5.3 Boundary authoring

Frameworks with split hooks use `openEvent(definition, input?)`, which returns:

```ts
interface EventScope<E extends DurationEvent> {
  run<T>(fn: () => T): T;
  bind<F extends AnyFunction>(fn: F): F;
  update(value: DeepPartial<EventInput<E>>): void;
  finish(
    value?: DeepPartial<EventInput<E>>,
    options?: { success?: boolean },
  ): void;
  fail(error: unknown, value?: DeepPartial<EventInput<E>>): void;
  cancel(reasonCode?: string): void;
}
```

Scopes close idempotently. A Plugin retains a scope only on true request-local framework state or in
a per-instance `WeakMap` keyed by that state. URLs, methods, routes, user IDs, and other non-unique
strings are forbidden correlation keys.

## 6. Runtime state and lifecycle

### 6.1 State machine

Each root and accepted duration occurrence follows:

```text
open -> closing -> closed
```

State never moves backward. Normal root lifecycle is:

1. Snapshot the active immutable runtime configuration generation.
2. Open before relevant framework/provider work.
3. Run input projection.
4. Execute the complete unit of work in isolated async context.
5. Reserve nested occurrences at invocation/start time.
6. Run result/success or error projection at the declared completion signal.
7. Move to closing and reject new reservations.
8. Omit and diagnose pending occurrences.
9. Sanitize and synchronously validate root and nested semantic values.
10. Create an immutable logical snapshot and move to closed.
11. Enrich resource attributes, redact, revalidate, sample, and deliver isolated values.
12. Return the original result or rethrow the exact original error.

Sink work may begin before step 12, but a synchronous application function never awaits async
delivery. `flush()` owns explicit draining.

### 6.2 Success and errors

`success` is application/business outcome only:

- normal return defaults to true;
- throw/rejection is false;
- returned failures such as HTTP status `>= 400` require a boundary classifier;
- a nested failure does not force root failure if application code handles it.

Projection, validation, truncation, timeout, redaction, sampling, and sink failure never set business
`success: false`; they are operational diagnostics.

Application result/error precedence is absolute. Accessing hostile thrown values is guarded. The
original thrown value is rethrown by identity even when safe structured error conversion fails.

### 6.3 Nested roots

Opening a different root inside an active root creates an independent record. Nested observations
attach only to the inner root until it closes, then the outer context is restored.

Re-entering the same root definition is a duplicate boundary: the outer scope remains sole owner,
the inner wrapper invokes application code transparently, skips its projectors, and does not deliver.

### 6.4 Deadlines

Every duration Event has a finite deadline. Runtime default is 300,000 ms and may be overridden by
`init({ limits: { maxEventDurationMs } })` or `maxDurationMs` on a definition.

A timed-out root is dropped and diagnosed out of band without inventing success. A timed-out nested
occurrence is omitted and diagnosed if its owner remains open. Application work continues; later
observations are inert; deadline timers do not keep the process alive.

## 7. Cardinality and occurrence frames

### 7.1 Single and repeated Events

For `"single"`, the first reservation owns the slot. Later calls execute normally, contribute
nothing, and produce one bounded duplicate diagnostic.

For `{ many: { max } }`:

- reserve the array index synchronously before provider work;
- preserve invocation order regardless of completion order;
- accept the first `max` reservations;
- drop newest on overflow; and
- record exact path, maximum, and dropped count under `@amplio.truncated`.

A rejected duplicate or overflow duration call runs within an inert shadow frame. Descendant Events
cannot leak into an accepted occurrence, sibling, or later root.

### 7.2 Nested duration Events

Each accepted duration occurrence owns a distinct child frame. Children attach relative to that
specific occurrence. Concurrent parent occurrences cannot share children even when they complete
out of order.

A child observed without its exact semantic parent occurrence active is inert and diagnosed. Closing
a parent closes its child frame before snapshotting.

### 7.3 Pending and late work

Unawaited work does not extend its owner:

- a pending slot at close is omitted;
- `@amplio.incomplete` records path and Event ID;
- late settlement is a no-op and cannot mutate the snapshot;
- `bind()` and normal ALS descendants retain their original occurrence until it closes;
- an unbound callback later invoked in another root follows that ambient root, a documented v1
  limitation.

## 8. Record and validation contract

### 8.1 Canonical envelope

Every delivered root contains:

```ts
{
  "@event": string,
  "@event_version": number,
  service: string,
  env: string,
  timestamp: string,
  duration_ms: number,
  success: boolean,
}
```

HTTP roots SHOULD contain a validated or generated `request_id`.

The runtime owns the envelope, optional structured `error`, `@amplio`, optional `resource`, and every
declared tree branch. Projectors, schemas, Plugins, and enrichers cannot overwrite them.

An instant nested Event contributes validated semantic output. A duration nested Event adds
`duration_ms`, `success`, and optional error:

```ts
type StructuredError = {
  type: string;
  code?: string;
  message?: string;
};
```

Raw stacks and arbitrary error properties are excluded. Message is omitted unless privacy policy
explicitly permits it.

### 8.2 Validation behavior

Validation runs on sanitized plain data. Successful schema transforms are sanitized again and
become the wire output.

- failed nested validation omits the occurrence and adds a bounded diagnostic;
- failed root validation drops the entire Event and diagnoses out of band;
- issue paths normalize to string/number Event paths;
- validation never changes application control flow.

### 8.3 Diagnostics

Operational metadata lives under `@amplio` with bounded, deduplicated entries:

```text
diagnostics[]  stable code, Event ID, and path
incomplete[]   pending Event ID and path
truncated[]    path, max, and dropped count
```

Production may omit verbose messages while retaining stable codes and counts.

### 8.4 JSON safety and bounds

Finalization is total: no projected value may make it throw. Sanitization MUST guard prototypes,
getters, proxies, cycles, and key enumeration; reject unsafe keys; preserve safe siblings; omit
functions/symbols/undefined object properties; convert BigInt to decimal strings and valid dates to
ISO; and construct plain sanitized objects with null prototypes.

Default limits are:

| Limit                                | Default |
| ------------------------------------ | ------: |
| Depth                                |      12 |
| Keys per Event                       |     512 |
| UTF-8 bytes per string               |   8 KiB |
| Semantic bytes per nested occurrence |  16 KiB |
| Serialized root size                 | 256 KiB |

When size exceeds limits, the runtime deterministically removes newest repeated occurrences, then
optional singles, then verbose diagnostic details. If root-owned semantic fields still exceed the
limit, the entire Event is dropped and diagnosed out of band.

## 9. Privacy and finalization pipeline

Generated Plugins explicitly project safe fields. They MUST NOT capture passwords, secrets, API
keys, tokens, authorization headers, cookies, raw bodies, raw URLs, query strings, provider objects,
or raw error messages by default.

For each closed root, the pipeline is:

1. validate and snapshot semantic input;
2. create an isolated working copy;
3. enrich only bounded `resource` attributes;
4. redact into another copy;
5. sanitize redactor output and restore protected runtime fields;
6. synchronously revalidate the complete Event tree;
7. drop fail-closed if redaction or revalidation fails;
8. sample the validated redacted record;
9. deliver isolated immutable records to sinks.

Sensitive data never reaches sampling hashes or sinks before redaction. A redactor may remove or
replace semantic fields only when the result remains schema-valid. Redactor failure never falls back
to unredacted delivery. Sampler failure drops the Event.

`onDiagnostic` runs outside active Event context behind a reentrancy guard. Throws, rejections, and
returned thenables are consumed and rate-limited. Diagnostics cannot recursively create Events.

## 10. Runtime configuration and delivery

### 10.1 Configuration generations

`init()` validates and atomically installs one immutable generation containing envelope defaults,
limits, enrichers, redactor, sampler, diagnostics, and sinks. Duplicate sink identities are
deduplicated.

Each root retains its opening generation through delivery, even if HMR replaces configuration.
Replaced generations retire and remain flushable while retained.

Defaults:

```ts
init({
  delivery: {
    maxPendingPerSink: 1_024,
    flushTimeoutMs: 5_000,
    maxRetiredGenerations: 4,
    retiredGenerationTtlMs: 30_000,
  },
});
```

If another replacement would exceed the retained-generation bound while an older generation owns
open roots, replacement is refused atomically and `config_generation_limit` is diagnosed. Hung
retired deliveries are abandoned after finite count/TTL bounds.

### 10.2 Sinks

```ts
type Sink = ((record: SinkRecord) => void | PromiseLike<void>) & {
  flush?: () => void | PromiseLike<void>;
};
```

A sink synchronously accepts/enqueues a record before returning. A returned thenable represents
completion of already accepted work. Sink throws/rejections are isolated and later sinks run.

Core tracks at most `maxPendingPerSink` unsettled deliveries. At the bound it does not invoke that
sink for a new Event, reports `sink_backpressure_drop`, and continues other sinks.

Each sink receives an immutable isolated value. Mutation by one sink cannot affect another sink,
later work, or definition-aware test retrieval.

### 10.3 `flush()`

`flush({ timeoutMs? })` snapshots active/retiring generations and a start-time accepted-delivery
watermark. It:

1. synchronously invokes each flush hook to seal pre-watermark partial batches;
2. collects returned thenables and delivery accepted at or before the watermark;
3. awaits only that work until the finite timeout; and
4. resolves `{ completed, pending, failures }` without throwing through shutdown code.

Delivery after the watermark belongs to a later flush. `flush()` does not wait for roots that have
not reached delivery.

## 11. Framework completion

Boundary Plugins span the strongest truthful lifecycle available without changing application
behavior:

- Next.js/Hono close on returned `Response` or thrown/rejected handler value and classify status;
- Express opens before the middleware chain and closes on response `finish` or `close`, preserving
  `next(error)`;
- Fastify opens in `onRequest` and closes after serialization and `onSend`/`onError`, using
  `onResponse` as final signal;
- queues close after ack/nack outcome;
- streaming completion is claimed only when native completion/abort hooks are owned;
- WebSocket HTTP Events close at upgrade outcome; messages use separate Events;
- fire-and-forget and `waitUntil` work are excluded unless explicitly owned and awaited.

Stable route templates are explicit. Raw paths and query strings are not route identifiers.

## 12. Open-code project and registry

### 12.1 Generated layout

```text
telemetry/
  events/
    http-request.ts
  plugins/
    next.ts
    resend.ts
  sinks/
  runtime.ts
amplio.json
instrumentation.ts
```

`runtime.ts` calls `init()` and exports no client, logger, mutable Event, or accessor. `amplio.json`
is CLI metadata only. VNext generation does not create component/fact/operation/workload/integration
or middleware directories.

### 12.2 Dependencies and registry metadata

Core has no provider imports, provider types, or provider peer dependencies. Registry recipes declare
host-owned provider/schema requirements and test minimum/latest compatible plus excluded boundary
versions.

Plugin metadata includes:

```text
slug, kind=plugin, role, recipeVersion, core range, provider ranges,
Event IDs/versions, files, wiring actions, privacy inclusions/exclusions
```

Registry Plugin tests use real native lifecycles where possible and include concurrent identical
requests plus forbidden-field snapshots.

### 12.3 Installation and updates

Default `amplio add plugin` preflights content digest, versions, existing files, Event selection,
unique placement, provider construction seam, boundary, dependencies, and planned source edits.

Installation is transactional for tracked source, package manifest, lockfile, and Amplio metadata.
`--target <relative-source-file>` provides explicit file selection and MUST reject absolute,
traversing, missing, non-source, or project-escaping paths before writes. Selection narrows discovery
only: provider/import authentication and same-file ambiguity checks remain mandatory. An active
Plugin cannot be implicitly retargeted. Non-interactive ambiguity aborts instead of guessing. The
CLI never executes arbitrary downloaded scripts and discloses normal package lifecycle scripts.

Successful installation leaves copied source, tree composition, dependencies, metadata, and safe
wiring complete. A repeated install creates no diff. `--source-only` is an explicit inert escape
hatch and causes `doctor --strict` to fail until composed. A supported manual Next.js or Express
attachment may be promoted by targeting its file only after the CLI verifies the documented native
shape. That wiring is recorded as customer-owned: activation and removal never rewrite it, strict
doctor re-verifies it, and removal refuses to delete Plugin source until live consumers are detached.

Updates use recorded base content and recoverable three-way merge. Conflicts never overwrite local
edits. Removing a Plugin does not remove its provider package.

## 13. Compatibility and migration

Target mapping:

| Alpha                             | VNext                                            |
| --------------------------------- | ------------------------------------------------ |
| `defineWorkload`                  | `event`                                          |
| fact/operation/component          | nested Event definitions inside Plugin `.events` |
| component tree                    | Event `tree` containing Plugin subtrees          |
| `integrations/`                   | `plugins/`                                       |
| `middleware/`                     | framework files in `plugins/`                    |
| `workloads/`                      | `events/`                                        |
| logger accessors, `.set`, `.emit` | removed with no business-code replacement        |
| `@useamplio/amplio/events`        | removed                                          |
| mutable builder compatibility     | temporary explicit `/legacy` only                |

Migration creates Event/Plugin directories, folds semantic definitions into the Plugin owning each
native seam, replaces adapters with native Plugin exports, composes `.events` into roots, and bans
legacy imports from recipes/examples. It MUST show the exact composition root selecting a new
instrumented export. `/legacy` is deleted before stable v1.

## 14. Acceptance gates

### Public/type surface

- Main exports `event`, `init`, and `flush` with no logger or alpha semantic primitives.
- Main, `/plugin`, and `/testing` build and pack with no vendor or legacy declaration leakage.
- Strict consumers infer projector args/results, schema transforms, wrapper signatures, nested
  optional placement, and repeated arrays without `any`.

### Function fidelity

- Sync stays sync; exact return/throw identity survives.
- Native and cross-realm Promise identity/settlement survives.
- Custom thenables are untouched.
- `this`, overloads, callbacks, ordering, and call count survive.
- Hostile projectors, schemas, values, and errors cannot escape.

### Tree/runtime

- Exact identity attaches; ID/type impostors do not.
- Trees are safely traversed, snapshotted, branded, and deeply frozen.
- Duplicate mounts fail before traffic.
- Optionality, ordering, overflow, shadow frames, occurrence children, pending work, late work,
  nested roots, same-root reentry, deadlines, and interleaved concurrency satisfy this specification.

### Privacy/delivery

- Canonical envelope and definition-aware records satisfy `EventRecord<E>`.
- Sanitization handles BigInt, cycles, throwing getters, proxies, and oversize input.
- Redaction precedes sampling/sinks and failure is fail-closed.
- Sink mutation/failure/backpressure is isolated.
- Flush honors hooks, watermark, timeout, generations, and returned counts.
- Diagnostic callbacks cannot escape, recurse, or create Events.

### Framework/Plugin/CLI

- Boundary tests exercise truthful framework completion and stable route templates.
- Plugin recipes test supported/excluded provider versions, native hooks, instance isolation, privacy,
  and inert behavior without a root.
- Clean installs are complete and idempotent; failures roll back tracked edits; updates preserve
  local changes; removals preserve providers.
- Application/domain fixtures contain no Amplio imports or instrumentation calls.
- Registry generation, runnable examples, packed cold install, typecheck, size, and publish smoke
  gates pass.
