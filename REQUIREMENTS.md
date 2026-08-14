# Product requirements — amplio

Amplio provides open-code semantic Events assembled automatically by Plugins at native application
and provider seams.

This Event/Plugin model supersedes the alpha Logger, fact, operation, component, workload,
integration, and middleware model.

## Problem

Most observability libraries make application authors repeatedly choose both meaning and mechanics:

```ts
getLogger()
  .set({ user: { id: user.id } })
  .emit();
```

The call site still invents field names, privacy policy, merge behavior, lifecycle, outcome, and
signal selection. Every call site creates another dialect and business code becomes coupled to
telemetry mechanics.

Amplio moves those decisions into editable Plugin code and a declared Event tree. Applications
select an instrumented provider at construction and a root Event at a framework or worker boundary.
Ordinary calls then contribute automatically.

## Product thesis

- An **Event** is a typed semantic node. A root Event represents one complete unit of work and owns
  the complete declared output tree.
- A **Plugin** is editable open code that connects a native framework, library, SDK, or local seam to
  exact Event definitions.
- One boundary invocation produces at most one immutable Event record before sampling.
- Business code does not retrieve, receive, mutate, or finalize a logger or Event.

Boundary, seam, tree, observation, and sink describe roles or configuration. They are not additional
customer-facing semantic primitives.

## Goals

1. **Ordinary business code** — application/domain code contains no telemetry mechanics.
2. **Two-concept model** — Event and Plugin are the only public semantic concepts.
3. **Declared document ownership** — one root Event reveals every nested placement.
4. **Native instrumentation** — Plugins attach through documented construction, hook, middleware,
   interceptor, or callback seams.
5. **Open-code ownership** — schemas, projections, provider hooks, privacy rules, sinks, and Event
   composition live in the customer's repository.
6. **Behavioral transparency** — instrumentation cannot change application-visible behavior.
7. **Bounded determinism** — cardinality, memory, size, deadlines, diagnostics, delivery, and updates
   have explicit finite behavior.
8. **Privacy by construction** — Plugins select safe fields explicitly and delivery fails closed.
9. **Transactional installation** — CLI operations never claim success for an inert, partial, or
   ambiguously wired Plugin.

The deletion test is mandatory: removing Amplio wrappers must change observability only.

## Non-goals

- A hosted observability backend, query UI, or control plane
- Free-form `info`, `warn`, or `debug` logging as the primary model
- A mutable request context exposed to application code
- One record per nested Event occurrence
- Replacing every metric or distributed trace use case
- Treating the Event tree as a causal or distributed trace DAG
- Automatic inference of domain meaning
- Automatic wrapping of unknown SDK methods or arbitrary imports
- Magical mutation of existing provider imports
- Implicit capture of detached or fire-and-forget work
- Browser, edge, Deno, or worker support while v1 relies on Node async context

## Functional requirements

### FR-1 Public surface

The main package MUST export `event`, `init`, `flush`, and the Event/schema/record/sink/configuration
types required to use them.

Advanced open-code Plugins import `plugin`, `openEvent`, and authoring types from
`@useamplio/amplio/plugin`. Definition-aware assertions and test sinks may live under
`@useamplio/amplio/testing`.

The main entrypoint MUST NOT export logger accessors/builders, `defineFact`, `defineOperation`,
`defineComponent`, `defineWorkload`, placement wrappers, vendor types, or global observation tools.

`init()` MUST return `void`. `runtime.ts` exports no logger, client, mutable Event, or accessor.

### FR-2 Event definitions

`event()` MUST define:

- a stable lowercase dot-separated semantic `id`;
- a positive integer wire `version`;
- a host-owned Standard Schema-compatible object schema;
- timing, defaulting to `"duration"`;
- cardinality, defaulting to `"single"`, or finite `{ many: { max } }`;
- an optional declared child tree; and
- an optional finite duration override.

Every Event has opaque process-local identity. Exact identity, never an ID string, structural match,
generic assertion, or registry lookup, determines attachment.

A duration Event exposes `handle()` and preserves the exact public function type. An instant Event
is nested-only. Projectors are synchronous, accept typed schema input patches, and cannot overwrite
runtime or tree-owned fields.

Schema input and output are JSON objects. `EventRecord<E>` MUST infer schema output, nested Event
placement, duration metadata, cardinality arrays, and optional branches without degrading to `any`.

### FR-3 Event tree

- Plain object keys determine record placement; IDs identify schemas and diagnostics only.
- Tree values are branded Event definitions or plain nested objects.
- Construction safely rejects arrays, accessors, symbols, proxies that fail traversal, cycles,
  unsafe prototype keys, reserved runtime keys, and duplicate mounts of one Event identity.
- Definitions and trees are snapshotted and deeply frozen.
- All mounted nested Events are optional in traffic. Empty branches are pruned and absent repeated
  Events are omitted rather than serialized as `[]`.
- Only duration Events may declare child trees. Each accepted duration occurrence owns an isolated
  child frame.

### FR-4 Plugins

A contributor Plugin MUST:

- expose a native instrumenter and a frozen `.events` subtree containing the exact definitions used
  by that instrumenter;
- attach only through `record()` for instant Events and `observe()` or `begin()` for duration Events
  belonging to its own subtree;
- preserve the provider's supported public shape, behavior, callbacks, and errors;
- remain inert and behaviorally safe without an active root that mounts it;
- keep mutable hook state instance-local; and
- use documented provider hooks or methods covered by compatibility tests.

A boundary Plugin owns a root lifecycle and is not mounted in the tree. Frameworks with split native
hooks use `openEvent()` plus request-local state, not URL/user/method correlation.

Plugins MUST NOT scan code, patch arbitrary imports, reflectively wrap future methods, create hidden
roots, expose tracking helpers to business code, or spread provider objects into records.

### FR-5 Behavioral transparency

Removing a wrapper MUST preserve:

- `this`, argument types/order/identity, overloads, and invocation count;
- synchronous versus asynchronous behavior;
- exact return values and thrown values;
- native Promise identity, fulfillment values, and rejection reasons;
- callback count, ordering, and provider hook ordering.

Genuine native and cross-realm Promises may be observed without reading a user-controlled `.then`.
Arbitrary thenables MUST remain untouched and are unsupported by `handle()`/`observe()` seams.

Telemetry failure MUST NOT replace an application result or error. VNext has no production runtime
strict mode that throws validation failures through successful work.

### FR-6 Lifecycle, cardinality, and concurrency

- One boundary invocation opens and closes at most one root Event.
- Input projection runs before work; result/success or error projection runs at the boundary's true
  completion signal.
- A normal return defaults to `success: true`; returned failure values require an explicit
  classifier. A throw/rejection records failure and rethrows the exact original value.
- Duplicate singles are first-reservation-wins and diagnosed once.
- Repeated observations reserve order before invocation, keep the first `max`, and drop newest on
  overflow without failing provider work.
- Rejected duplicate/overflow duration calls enter inert shadow frames so descendants cannot leak.
- Pending observations at close are omitted and diagnosed incomplete. Late work cannot mutate a
  closed record or attach to a later root.
- Different nested root definitions isolate and restore context. Re-entering the same root skips
  inner projectors and does not double-deliver.
- Every duration Event has a finite deadline. Timeout never invents business success or failure.
- Interleaved roots and provider instances MUST not cross-contaminate.

### FR-7 Record, schema, and privacy

Every delivered root MUST include:

```text
@event
@event_version
service
env
timestamp
duration_ms
success
```

Duration nested Events additionally own `duration_ms`, `success`, and optional safe structured
`error`. Operational health belongs under bounded `@amplio` diagnostics, never business `success`.

Validation uses Standard Schema-compatible structural types without a core dependency on Zod or
another schema library. Async validation is unsupported in v1: the affected nested Event or root is
dropped and diagnosed without changing application behavior.

The runtime MUST sanitize hostile or non-JSON values safely, enforce depth/key/string/array/record
limits, protect prototype and runtime keys, and produce a logical immutable snapshot.

Generated Plugins MUST exclude passwords, secrets, tokens, cookies, authorization headers, raw
bodies, raw URLs, query strings, and raw provider objects by default. Redaction runs before sampling
and sinks. Redactor, sampler, or post-redaction validation failure drops the Event fail-closed.

### FR-8 Runtime configuration and delivery

- Each root snapshots one immutable runtime configuration generation at open.
- Reconfiguration atomically replaces the active generation and retains only bounded retiring
  generations.
- Enrichers operate only on bounded operational `resource` attributes, not semantic Event fields.
- Sampling operates on the complete redacted root; nested Events are never sampled independently.
- Sink failures are isolated and later sinks still run.
- Pending delivery is bounded per sink; overflow is observable and non-blocking.
- `flush()` uses a finite timeout and start-time watermark, invokes sink flush hooks, and returns
  completed/pending/failure counts without throwing through shutdown code.
- Missing initialization results in no delivery and a rate-limited development diagnostic.
- Diagnostic callbacks are bounded, isolated, non-recursive, and run outside active Event context.

### FR-9 Framework truth

Boundary Plugins MUST span the strongest lifecycle their framework exposes and document their exact
completion signal.

- Next.js and Hono classify the returned `Response` or thrown/rejected value.
- Express spans the middleware chain and closes on response `finish` or `close` while preserving
  `next(error)`.
- Fastify spans `onRequest` through serialization, `onSend`/`onError`, and `onResponse`.
- Queue boundaries close only after ack/nack outcome is known.
- Streaming completion is claimed only when native completion/abort hooks are owned without wrapping
  or replacing application results.
- Stable route templates are recorded; raw paths and query strings are not route names.

### FR-10 Open-code registry and CLI

`amplio init` MUST create `telemetry/runtime.ts`, a first root Event, the detected boundary Plugin,
and a development sink. VNext generated source uses `telemetry/events/` and `telemetry/plugins/`.

Canonical grammar distinguishes Event IDs from Plugin slugs:

```bash
amplio add event billing.reconciliation
amplio add plugin resend --event billing.reconciliation
amplio diff plugin resend
amplio update plugin resend
amplio remove plugin resend
amplio doctor --strict
```

Registry metadata MUST declare Plugin role, recipe version, core/provider compatibility, Event IDs
and wire versions, files, wiring actions, and privacy fields.

Core MUST have no vendor imports or vendor peer dependencies. Provider/schema dependencies are
owned by the host application. The CLI verifies compatible existing versions and never silently
upgrades or downgrades them.

Default installation MUST preflight and transactionally compose source, Event tree, manifest,
dependency state, and supported provider wiring. Ambiguous roots or seams require explicit user
selection. `--target <relative-source-file>` MUST select only one existing contained source file,
MUST NOT weaken native provider/import authentication, and MUST reject absolute, traversing,
missing, non-source, or escaping targets before writes. It MUST NOT silently retarget an active
Plugin. Repeated installation is idempotent. Updates preserve local edits through recoverable
three-way merge. Removal does not remove the provider package.

When a supported Next.js or Express boundary is attached manually, active installation MAY adopt it
only after verifying its exact documented native shape. Adopted wiring remains customer-owned: add
and remove MUST NOT rewrite it, strict doctor MUST re-verify it, and removal MUST preserve Plugin
source while any live import or reference remains.

### FR-11 Compatibility and migration

Alpha mutable builders MAY remain temporarily under `@useamplio/amplio/legacy`. They MUST NOT be
re-exported from main, used by generated code, or taught in current docs, and MUST be removed before
stable v1.

Migration maps workloads to root Events, facts/operations/components to nested Plugin Events,
integrations/middleware to Plugins, and component trees to Event trees. The CLI must show the exact
composition root that selects a newly instrumented export; creating an unused re-export is not a
successful migration.

## Quality requirements

- The main declaration graph contains no legacy logger or vendor types.
- Strict consumers infer schema input/output transforms, wrapper signatures, nested placement, and
  repeated arrays through built declarations.
- Runtime tests cover function fidelity, identity, tree safety, occurrence frames, concurrency,
  bounds, deadlines, hostile values, validation, privacy, and delivery.
- Registry Plugins test minimum/latest supported and excluded provider versions plus real native
  lifecycles where available.
- Application/domain fixtures contain no Amplio import or instrumentation vocabulary.
- CLI operations are tested in temporary clean projects, including rollback and update conflicts.
- Framework and standalone examples run end to end.
- Packed cold consumers install and typecheck outside the monorepo.
- Main runtime remains within the repository's enforced gzip budget without weakening correctness.

## Success criteria

1. One root Event file reveals the complete semantic output placement.
2. A provider is instrumented once at its native construction seam; downstream calls remain native.
3. One request/job/message produces at most one immutable, type-valid root record.
4. Two interleaved roots and identical provider requests remain isolated and deterministic.
5. Missing, failing, or removed telemetry never changes application behavior.
6. Plugin installation is complete, idempotent, reviewable, and recoverable.
7. A packed strict consumer uses main, `/plugin`, and `/testing` without legacy or vendor leakage.
