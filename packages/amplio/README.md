# @useamplio/amplio

Amplio turns a request, job, message, command, or other unit of work into one typed semantic Event,
assembled automatically by open-code Plugins at the native seams where work already happens.

Business code calls ordinary functions. It does not retrieve a logger, mutate an Event, or emit
telemetry.

## Install

Install the core plus a host-owned Standard Schema implementation. This walkthrough uses Zod:

```bash
pnpm add @useamplio/amplio zod
```

Provider SDKs and schema libraries belong to the application. Amplio core has no vendor dependency.

Amplio vNext requires Node.js 20 or newer and uses `node:async_hooks`. It is server-only in this
release: browsers, Edge runtimes, Deno, and worker runtimes such as Cloudflare Workers are not
supported.

## Project shape

```text
telemetry/
  events/
    http-request.ts
  plugins/
    email.ts
    request.ts
  sinks/
    console.ts
  runtime.ts
```

One root Event file reveals the complete output placement. Plugin files contain editable schemas,
projections, privacy choices, and provider/framework hooks.

## 1. Configure delivery once

```ts
// telemetry/sinks/console.ts
import type { Sink } from "@useamplio/amplio";

export const consoleSink: Sink = (record) => {
  console.log(JSON.stringify(record));
};
```

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

`init()` returns `void`. Load this module once from the application's normal instrumentation or
startup hook:

```ts
// instrumentation.ts
import "./telemetry/runtime.js";
```

## 2. Write an open-code contributor Plugin

This Plugin observes an existing email-provider function. It records only the safe template ID and
a stable provider name; recipient, subject, body, headers, and credentials never enter telemetry.

```ts
// telemetry/plugins/email.ts
import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";

export type SendEmail = (input: {
  templateId: string;
}) => Promise<{ id: string }>;

export const EmailPlugin = plugin({
  id: "email",
  events: {
    sends: event({
      id: "email.send",
      version: 1,
      schema: z.object({
        template: z.string(),
        provider: z.literal("example-email"),
      }),
      timing: "duration",
      cardinality: { many: { max: 8 } },
    }),
  },

  instrument({ events, observe }) {
    return function instrumentEmail<F extends SendEmail>(send: F): F {
      return observe(events.sends, send, {
        input: ({ args: [input] }) => ({
          template: input.templateId,
          provider: "example-email",
        }),
      });
    };
  },
});
```

`EmailPlugin` is both the native instrumenter and the owner of the exact Event definitions exposed
under `.events`. Plugin tools are available only inside `instrument(...)`; application code cannot
import a global `observe()` or `record()`.

## 3. Mount the exact Plugin Events

```ts
// telemetry/events/http-request.ts
import { event } from "@useamplio/amplio";
import { z } from "zod";
import { EmailPlugin } from "../plugins/email.js";

const HttpRequestFields = z.object({
  request_id: z.string(),
  http: z.object({
    method: z.string(),
    route: z.string(),
    status: z.number().int().optional(),
  }),
});

export const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: HttpRequestFields,
  tree: {
    email: EmailPlugin.events,
  },
});
```

The key `email` chooses record placement. Attachment uses the exact definition values from
`EmailPlugin.events`, never an ID string or generic assertion. Mounted nested Events are optional in
traffic, so an HTTP request that sends no email simply omits `email`.

## 4. Instrument the provider construction seam once

Assume `sendEmailNative` is the application's existing provider export:

```ts
// src/email.ts
import { EmailPlugin } from "../telemetry/plugins/email.js";
import { sendEmailNative } from "./vendor/email-client.js";

export const sendEmail = EmailPlugin(sendEmailNative);
```

Every downstream call keeps the provider's normal signature, return value, error, and native Promise
identity. Outside an active root that mounts `EmailPlugin.events`, the call still works and produces
no Event contribution.

## 5. Own the request boundary

```ts
// telemetry/plugins/request.ts
import { HttpRequest } from "../events/http-request.js";

type Handler = (request: Request) => Response | Promise<Response>;

function requestId(headers: Headers): string {
  const incoming = headers.get("x-request-id");
  return incoming && /^[A-Za-z0-9_-]{1,128}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
}

export function withAmplio<F extends Handler>(route: string, handler: F): F {
  return HttpRequest.handle(handler, {
    input: ({ args: [request] }) => ({
      request_id: requestId(request.headers),
      http: {
        method: request.method,
        route,
      },
    }),
    result: ({ result }) => ({
      http: { status: result.status },
    }),
    success: ({ result }) => result.status < 400,
  });
}
```

The route template is explicit; a raw path or query string is not a route name. Frameworks whose
true lifecycle spans native hooks use `openEvent()` from `@useamplio/amplio/plugin` instead of a
handler-only wrapper.

## 6. Keep business code ordinary

```ts
// src/orders/place-order.ts
import { sendEmail } from "../email.js";

export async function placeOrder(input: { email: string }) {
  const order = { id: crypto.randomUUID() };

  await sendEmail({
    templateId: "order_confirmation",
  });

  return order;
}
```

```ts
// src/app/api/orders/route.ts
import { withAmplio } from "../../../../telemetry/plugins/request.js";
import { placeOrder } from "../../../orders/place-order.js";

async function placeOrderRoute(request: Request) {
  const input = (await request.json()) as { email: string };
  const order = await placeOrder(input);
  return Response.json(order, { status: 201 });
}

export const POST = withAmplio("/api/orders", placeOrderRoute);
```

The business module imports neither `@useamplio/amplio` nor local telemetry. Only provider
construction, boundary registration, and runtime bootstrap select instrumentation.

## Result

One request produces at most one immutable root record before sampling:

```json
{
  "@event": "http.request",
  "@event_version": 1,
  "service": "orders-api",
  "env": "production",
  "timestamp": "2026-08-13T22:10:14.231Z",
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
        "template": "order_confirmation",
        "provider": "example-email",
        "duration_ms": 42,
        "success": true
      }
    ]
  }
}
```

Repeated Events preserve invocation order and enforce their declared maximum. Pending observations
are omitted at close, late completion cannot mutate the delivered snapshot, and telemetry failures
never replace application results or errors.

## Flush accepted delivery

Call `flush()` after the application work you intend to drain has completed:

```ts
import { flush } from "@useamplio/amplio";

const result = await flush();
if (result.pending > 0 || result.failures > 0) {
  console.error("Amplio delivery did not fully drain", result);
}
```

`flush()` has a finite timeout and drains only work accepted by its start-time watermark; later work
belongs to the next call.

## Compatibility

Mutable builder compatibility is quarantined at `@useamplio/amplio/legacy`; it is not re-exported
from main, used by generated code, or part of the Event/Plugin design.

## License

MIT
