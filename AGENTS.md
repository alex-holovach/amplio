# AGENTS.md — amplio

Instructions for contributors and coding agents working on the amplio monorepo.

## Product in one sentence

Amplio turns a request, job, message, command, or other unit of work into one typed semantic Event,
assembled automatically by open-code Plugins at the native seams where work already happens.

## Authority

- [REQUIREMENTS.md](./REQUIREMENTS.md) defines product requirements.
- [SPEC.md](./SPEC.md) defines the executable runtime contract.
- When implementation and these documents differ, update the decision in REQUIREMENTS first, make
  SPEC precise, then change code and acceptance tests.

The Event/Plugin model supersedes the alpha Logger, fact, operation, component, workload,
integration, and middleware model.

## Non-negotiable laws

1. **No logger in application code.** Do not introduce logger parameters, ambient accessors,
   `.set()`, `.emit()`, public capture calls, or mutable event objects.
2. **Ordinary code wins.** Wrappers preserve `this`, arguments, sync/async behavior, return values,
   thrown values, native Promise identity, callbacks, ordering, and invocation count.
3. **One unit of work, one Event.** A boundary closes at most once and produces at most one immutable
   root record before sampling.
4. **The Event is a declared tree.** A Plugin contributes only through the exact Event definition
   values mounted beneath the active root.
5. **Plugins attach at native seams.** Prefer official hooks, middleware, interceptors, or explicit
   construction wrappers. Never scan arbitrary imports or monkeypatch unknown methods.
6. **Open code owns meaning.** Schemas, projections, privacy choices, provider hooks, trees, sinks,
   and enrichers remain readable TypeScript in the customer's repository.
7. **Behavior is bounded and deterministic.** Repeated branches, pending work, record size, delivery
   queues, shutdown, diagnostics, and runtime generations all have finite bounds.
8. **Privacy starts at projection.** Select safe fields explicitly. Redaction is defense in depth,
   not permission to capture provider objects, bodies, tokens, cookies, raw URLs, or query strings.

The deletion test is mandatory: removing an Amplio wrapper must change observability only, not
application behavior.

## Public architecture

Amplio has two customer-facing semantic concepts:

- **Event** — a typed semantic node. A root Event owns one complete unit of work; nested Events
  represent bounded semantics contributed by Plugins.
- **Plugin** — editable open code that connects a framework, provider, SDK, or local subsystem to
  Events through a real native seam.

Boundary and contributor are Plugin roles, not extra semantic primitives:

- a **boundary Plugin** opens and closes a root Event and is not mounted in its tree;
- a **contributor Plugin** bundles nested Events under `.events` and observes provider-native seams.

Main entrypoint `@useamplio/amplio`:

| Interface                                            | Role                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| `event`                                              | Define a versioned Event and its declared tree               |
| `init`                                               | Install runtime configuration by side effect; returns `void` |
| `flush`                                              | Drain accepted asynchronous delivery to a finite watermark   |
| Event, schema, record, sink, and configuration types | Public type contract                                         |

Plugin authoring entrypoint `@useamplio/amplio/plugin`:

| Interface                                 | Role                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| `plugin`                                  | Bundle exact Event definitions with a native instrumenter    |
| `openEvent`                               | Own framework lifecycles that span native hooks or callbacks |
| `PluginTools`, `EventScope`, and `Plugin` | Authoring-only types                                         |

Testing entrypoint `@useamplio/amplio/testing` may expose definition-aware test sinks and explicit
assertions. Production wrappers never infer strictness from `NODE_ENV` and never throw telemetry
validation failures through successful application work.

The main entrypoint MUST NOT export `Logger`, `getLogger`, `useLogger`, `defineFact`,
`defineOperation`, `defineComponent`, `defineWorkload`, `optional`, `many`, `group`, or public
`record`/`observe` helpers. Alpha compatibility may remain temporarily under `/legacy` only.

## Repository layout

```text
packages/amplio/       Event runtime, Plugin authoring surface, delivery, legacy quarantine
packages/cli/          init/add/diff/update/remove/doctor and open-code generation
registry/              source Plugin recipes, Events, sinks, and registry metadata
public/r/              built shadcn-compatible registry JSON
examples/              runnable no-logger reference applications
benchmarks/            performance and main-entry size gates
scripts/               registry, publish, and repository verification
REQUIREMENTS.md        product requirements
SPEC.md                executable runtime contract
```

Work in the narrowest module that owns the change. Keep CLI generation out of the runtime and
runtime lifecycle machinery out of application examples.

## Customer tree

```text
telemetry/
├── events/
│   ├── http-request.ts
│   └── billing-reconciliation.ts
├── plugins/
│   ├── next.ts
│   ├── resend.ts
│   └── better-auth.ts
├── sinks/
└── runtime.ts
```

The project may also contain `amplio.json` for CLI install/update metadata and a framework bootstrap
such as `instrumentation.ts`. `amplio.json` is never read at runtime. Optional folders such as
`enrichers/` are created only when installed.

The CLI MUST NOT create `components/`, `facts/`, `operations/`, `workloads/`, `integrations/`, or
`middleware/` directories for the vNext model.

Application code may import local telemetry only at provider construction, framework or worker
registration, an exported job boundary, and runtime bootstrap. Domain modules import neither the
core package nor local telemetry.

## Runtime invariants

- Every `event()` call creates one opaque process-local identity.
- Placement comes from root tree keys; semantic IDs do not select placement.
- All mounted nested Events are optional in traffic and absent branches are omitted.
- Cardinality belongs to the nested Event definition: `"single"` or finite `{ many: { max } }`.
- Duplicate singles are first-reservation-wins. Repeated Events preserve invocation order and drop
  newest on overflow.
- Rejected duplicate and overflow duration calls execute application code inside inert shadow
  frames so descendants cannot leak.
- Every accepted duration occurrence owns a distinct child frame.
- Pending observations are omitted at close and reported incomplete; late completion cannot mutate
  a closed snapshot.
- Different nested roots isolate and restore context. Re-entering the same root definition does not
  double-deliver or rerun inner projectors.
- A genuine native or cross-realm Promise is observed without changing its identity. Arbitrary
  thenables are untouched and unsupported by `handle()` and `observe()`.
- Schema, projector, sanitizer, enrichment, redaction, sampling, diagnostic, and sink failures never
  alter application results or errors.
- Root validation failure drops the Event. Nested validation failure omits that occurrence.
- Every duration Event has a finite deadline; timers do not keep the process alive.

Read [SPEC.md](./SPEC.md) before changing Event, Plugin, context, finalization, or delivery code.

## Plugin rules

1. A contributor Plugin returns a native instrumenter and exposes the exact same definitions under
   its frozen `.events` tree.
2. `record()` accepts only instant Events. `observe()` and `begin()` accept only duration Events from
   that Plugin's own `.events` tree.
3. A contributor never opens a hidden root. Outside an active declaring root it is telemetry-inert
   and behaviorally transparent.
4. Wrap only documented provider methods or hooks covered by compatibility tests.
5. Keep mutable provider-hook state instance-local. Correlate split hooks only with genuine
   request-local objects or a per-instance `WeakMap`.
6. Project fields explicitly. Do not spread provider input, output, request, error, or context
   objects.
7. Registry Plugin metadata declares `role: "boundary" | "contributor"`, compatible core/provider
   ranges, Event IDs and versions, files, wiring actions, and privacy inclusions/exclusions.
8. Provider and schema packages belong to the host application. Core has no vendor imports or peer
   dependencies.

## Code generation and CLI rules

Canonical commands are:

```bash
pnpm exec amplio init
pnpm exec amplio add event billing.reconciliation
pnpm exec amplio add plugin resend --event billing.reconciliation
pnpm exec amplio diff plugin resend
pnpm exec amplio update plugin resend
pnpm exec amplio remove plugin resend
pnpm exec amplio doctor --strict
```

- Generate explicit, formatted, hand-editable TypeScript.
- Use framework-appropriate imports: NodeNext output uses `.js`; bundler recipes may use
  extensionless specifiers.
- Preflight registry source, versions, files, Event selection, tree placement, provider seam, and
  boundary before writing.
- Default installation is transactional and complete: copied source, Event composition, host
  dependencies, manifest, lockfile, and supported wiring either succeed together or tracked edits
  are restored.
- Never silently upgrade or downgrade a host provider.
- Never overwrite open-code files without explicit approval. Updates use a recoverable three-way
  merge and surface conflicts.
- Ambiguous roots or construction seams require explicit user selection. Non-interactive commands
  abort rather than guess.
- `--source-only` may copy inert source only when explicitly requested and must make
  `doctor --strict` report the missing composition.
- Removing a Plugin does not remove its provider package.

## Naming

| Thing                       | Convention               | Example                          |
| --------------------------- | ------------------------ | -------------------------------- |
| Root Event value            | PascalCase               | `HttpRequest`                    |
| Nested Plugin Event key     | lowercase snake_case     | `signed_in`, `sends`             |
| Event semantic ID           | lowercase dot-separated  | `http.request`, `auth.signed_in` |
| Event wire version          | positive integer         | `version: 1`                     |
| Plugin export               | PascalCase plus `Plugin` | `BetterAuthPlugin`               |
| Plugin ID and registry slug | lowercase kebab-case     | `better-auth`                    |
| Record/tree key             | lowercase snake_case     | `request_id`, `payment_attempts` |
| File                        | kebab-case               | `better-auth.ts`                 |

IDs and tree keys never contain user IDs, raw URLs, timestamps, or other high-cardinality values.

## Testing expectations

Validate the narrow change first, then the relevant consumer path:

```bash
pnpm --filter @useamplio/amplio test
pnpm --filter @useamplio/amplio typecheck
pnpm --filter @useamplio/cli test
pnpm --filter @useamplio/cli typecheck
pnpm registry:build
pnpm typecheck
pnpm smoke
pnpm size
pnpm publish:smoke
```

Required gates include:

- exact public and built declaration surfaces for main, `/plugin`, and `/testing`;
- function fidelity, hostile values, native/cross-realm Promise identity, and untouched thenables;
- identity, deep-frozen trees, optionality, cardinality, occurrence frames, concurrency, deadlines,
  pending work, nested roots, and immutable snapshots;
- schema input/output transforms, JSON safety, privacy snapshots, fail-closed redaction, sampling,
  and sink isolation;
- no-pollution fixtures with no Amplio imports or instrumentation vocabulary in application/domain
  source;
- real framework completion tests and provider compatibility tests;
- temp-directory transactional CLI tests, registry strict typechecks, runnable examples, and packed
  cold-consumer install/typecheck.

Run `git diff --check` before handoff. Preserve unrelated changes and never weaken a contract merely
to make its test pass.

## Review vocabulary

- **Event** — typed semantic node; a root owns one unit of work.
- **Plugin** — open-code adapter and installation unit.
- **Boundary** — lifecycle point that opens and closes a root Event.
- **Seam** — native provider or framework attachment point.
- **Tree** — declared document ownership and placement, not a trace DAG.
- **Observation** — one occurrence of a nested Event.
- **Sink** — operational delivery configuration, not a semantic authoring concept.

## Anti-slop

- No free-form string logging as the primary model.
- No logger, mutable record, or global observation helper in application code.
- No public semantic ontology beyond Event and Plugin.
- No hidden vendor semantics or vendor dependency in core.
- No anonymous unbounded schemas or repeated telemetry.
- No output order based on Promise completion timing.
- No blanket monkeypatching, import scanning, or unsafe global correlation.
- No default PII, secret, raw body, raw URL, query, cookie, token, or authorization capture.
- No claim that the Event tree is a distributed trace or execution DAG.

## Git and release guidance

- Scope commits by coherent product concern.
- Do not commit credentials, generated local output, or packed tarballs.
- Do not push or publish unless explicitly requested.
- Update acceptance checkboxes only after the corresponding executable gate passes.
- Keep `/legacy` explicit and temporary; delete it before stable v1.
