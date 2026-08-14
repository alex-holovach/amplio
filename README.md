# amplio

Open-code semantic Events for requests, jobs, messages, commands, and every other meaningful unit
of work.

Your application calls ordinary functions. Amplio Plugins observe those functions at native seams
and contribute to one typed Event tree. There is no logger to pass, retrieve, mutate, or remember to
emit.

Amplio vNext requires Node.js 20 or newer and runs on the server through `node:async_hooks`. Browser,
Edge, Deno, and worker runtimes such as Cloudflare Workers are not supported in this release.

```ts
// application code
const order = await placeOrder(input);
return Response.json(order, { status: 201 });
```

## Quick start

This active walkthrough assumes the application already has one `new Hono()` composition root and
one `new Resend(...)` client construction. Provider dependencies stay application-owned; when a
Plugin dependency is missing, the CLI shows the complete install plan and rollback boundary before
asking for approval.

```bash
pnpm add @useamplio/amplio zod resend
pnpm add --save-dev @useamplio/cli
pnpm exec amplio init --service orders-api
pnpm exec amplio add plugin hono
pnpm exec amplio add plugin resend --event http.request
```

Amplio copies editable source into the application:

```text
telemetry/
  events/
    http-request.ts
  plugins/
    hono.ts
    resend.ts
  sinks/
    console.ts
  runtime.ts
amplio.json
```

- `events/` declares root schemas and complete tree placement.
- `plugins/` attaches semantics at framework, provider, and local function seams.
- `sinks/` contains editable delivery adapters.
- `runtime.ts` calls `init(...)` and exports no logger.
- `amplio.json` tracks installed source, Event placement, and native attachment metadata for CLI
  verification; runtime code never reads it.

## Declare the Event tree

```ts
// telemetry/events/http-request.ts
import { event } from "@useamplio/amplio";
import { z } from "zod";
import { ResendPlugin } from "../plugins/resend.js";

export const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({
      method: z.string(),
      route: z.string(),
      status: z.number().int().optional(),
    }),
  }),
  tree: {
    email: ResendPlugin.events,
  },
});
```

The property key `email` chooses output placement. Every leaf is an exact Event definition exported
by a Plugin. A mounted branch may be absent in traffic; a request that sends no email simply omits
`email`.

## Attach a Plugin at the native seam

```ts
// telemetry/plugins/resend.ts
import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import type { CreateEmailOptions, Resend } from "resend";
import { z } from "zod";

const ResendSend = event({
  id: "resend.send",
  version: 1,
  schema: z.object({
    provider: z.literal("resend"),
    template: z.string().optional(),
  }),
  timing: "duration",
  cardinality: { many: { max: 16 } },
});

const templateTag = (input: CreateEmailOptions): string | undefined =>
  input.tags?.find((tag) => tag.name === "template")?.value;

const instrumentedClients = new WeakSet<Resend>();

export const ResendPlugin = plugin({
  id: "resend",
  events: { sends: ResendSend },
  instrument({ events, observe }) {
    return <Client extends Resend>(client: Client): Client => {
      if (instrumentedClients.has(client)) {
        return client;
      }

      const send = client.emails.send.bind(client.emails);
      client.emails.send = observe(events.sends, send, {
        input: ({ args: [input] }) => {
          const template = templateTag(input);
          return {
            provider: "resend",
            ...(template ? { template } : {}),
          };
        },
        success: ({ result }) => result.error === null,
      });
      instrumentedClients.add(client);
      return client;
    };
  },
});
```

Wrap provider construction once:

```ts
import { Resend } from "resend";
import { ResendPlugin } from "../telemetry/plugins/resend.js";

export const resend = ResendPlugin(new Resend(process.env.RESEND_API_KEY));
```

Every downstream call keeps the provider's normal interface:

```ts
await resend.emails.send(message);
```

Only explicitly projected fields enter the Event. The default Resend Plugin excludes recipients,
subject, body, headers, and credentials.

## Own the full framework lifecycle

A framework Plugin opens one root Event, runs the ordinary framework chain inside it, and closes
after the framework exposes final status or error state. The Hono Plugin, for example, wraps
`await next()` rather than a single route handler:

```ts
const handleRequest = HttpRequest.handle(
  async (context, next) => {
    await next();
  },
  {
    input: ({ args: [context] }) => ({
      request_id: resolveRequestId(context.req.header("x-request-id")),
      http: { method: context.req.method },
    }),
    result: ({ args: [context] }) => ({
      http: {
        route: context.req.routePath,
        status: context.res.status,
      },
    }),
    success: ({ args: [context] }) => context.res.status < 400,
  },
);
```

The shared resolver accepts an incoming request ID only when the complete value matches
`[A-Za-z0-9_-]{1,128}`; every other value is replaced before it reaches the Event.

Express Plugins begin before the first route handler and settle on response completion. Fastify
Plugins span `onRequest` through `onResponse`. Next Plugins require an explicit stable route
template. The framework's true lifecycle decides the seam.

## Result

One request produces one immutable record:

```json
{
  "@event": "http.request",
  "@event_version": 1,
  "service": "orders-api",
  "env": "production",
  "timestamp": "2026-08-14T07:00:00.000Z",
  "request_id": "req_01K2...",
  "duration_ms": 84,
  "success": true,
  "http": {
    "method": "POST",
    "route": "/api/orders",
    "status": 201
  },
  "email": {
    "sends": [
      {
        "provider": "resend",
        "template": "order_confirmation",
        "duration_ms": 42,
        "success": true
      }
    ]
  }
}
```

Repeated nested Events preserve invocation order and enforce their declared maximum. Pending
observations are omitted at close, late completion cannot mutate the delivered snapshot, and
telemetry failures never replace application results or errors.

## Runtime and delivery

```ts
// telemetry/runtime.ts
import { init } from "@useamplio/amplio";
import { consoleSink } from "./sinks/console.js";

init({
  service: "orders-api",
  env: process.env.NODE_ENV ?? "development",
  sinks: [consoleSink],
});
```

`init()` returns `void`. Load this module once from normal server startup or the framework's
instrumentation hook.

Call `flush()` after application work that must be delivered before shutdown:

```ts
import { flush } from "@useamplio/amplio";

const result = await flush({ timeoutMs: 5_000 });
```

Flush uses a finite timeout and a start-time watermark. It reports completed, pending, and failed
delivery without changing application behavior.

## Public surface

| Import                     | Symbol      | Role                                                           |
| -------------------------- | ----------- | -------------------------------------------------------------- |
| `@useamplio/amplio`        | `event`     | Define a root or nested semantic Event                         |
| `@useamplio/amplio`        | `init`      | Configure service, environment, privacy, sampling, and sinks   |
| `@useamplio/amplio`        | `flush`     | Drain accepted delivery with a finite result                   |
| `@useamplio/amplio/plugin` | `plugin`    | Author a native instrumenter and its owned Events              |
| `@useamplio/amplio/plugin` | `openEvent` | Span native hook lifecycles that cannot use a function wrapper |

Plugin tools such as `observe`, `record`, and `begin` exist only inside `plugin({ instrument })`.
Application code cannot mutate the active Event.

## CLI

```bash
amplio init
amplio add plugin hono
amplio add event billing.reconciliation
amplio add plugin resend --event http.request
amplio diff plugin resend
amplio update plugin resend
amplio remove plugin resend
amplio add sink otlp
amplio list plugin
amplio doctor --strict
```

Generated telemetry is TypeScript and remains ordinary editable source. The CLI does not overwrite
an existing open-code file unless `--force` is explicit.

## Philosophy

| Principle               | Consequence                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| No logger               | No ambient accessor, mutable bag, `.set()`, or `.emit()`                        |
| Open code               | Schemas, projection, privacy, framework hooks, and sinks live in the repository |
| Declared tree           | One Event file reveals semantic placement before code runs                      |
| Native Plugins          | Meaning attaches where the framework, provider, or local function knows it      |
| Behavioral transparency | Removing a Plugin leaves application signatures and behavior intact             |
| One unit, one Event     | Lifecycle owners close automatically; application code never emits              |

## Development

```bash
pnpm install
pnpm run ci
pnpm smoke
pnpm publish:smoke
```

See [REQUIREMENTS.md](./REQUIREMENTS.md) for product invariants and [SPEC.md](./SPEC.md) for the
runtime contract.

## License

MIT
