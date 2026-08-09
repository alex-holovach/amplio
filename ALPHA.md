# amplio alpha guide

Schema-first wide-event telemetry that installs as open code in your repo.

**Status:** public alpha (`0.1.0-alpha.x`). APIs may change.

## Install (≈ 5 minutes)

From an existing Node 20+ app:

```bash
npx @useamplio/cli@alpha init --service my-app --yes
```

That command:

1. Scaffolds `telemetry/` + `amplio.json` + `components.json`
2. Installs `@useamplio/amplio` and `zod`
3. Auto-detects Next.js / Hono / Express / Fastify and scaffolds middleware + a starter event when possible

> The unscoped name `amplio` cannot be published on npm (typo-squatting block). Always use `@useamplio/cli`.

### Hono

```bash
pnpm add hono
# or: npm install hono  |  yarn add hono
npx @useamplio/cli@alpha init --service my-app --middleware hono --event auth.user.signed_up --yes
```

Wire middleware:

```ts
import { Hono } from "hono";
import { amplioMiddleware } from "./telemetry/middleware/hono";

const app = new Hono();
app.use("*", amplioMiddleware());
```

Emit in a route:

```ts
import { useRequestLogger } from "./telemetry/middleware/hono";
import { AuthUserSignedUp } from "./telemetry/events/auth/user-signed-up";

app.post("/signup", async (c) => {
  const log = useRequestLogger(c);
  log.event(AuthUserSignedUp).set({
    user: { id: "u_123" },
    signup: { method: "email" },
  });
  // middleware emits the request event when the response finishes
  return c.json({ ok: true });
});
```

You should see one JSON object on stdout per request (console sink from `telemetry/logger.ts`).

### Next.js (App Router)

```bash
npx @useamplio/cli@alpha init --service my-app --middleware next --event auth.user.signed_up --yes
```

Wrap a route handler:

```ts
import { withAmplio } from "@/telemetry/middleware/next";
import { useLogger } from "@useamplio/amplio";
import { AuthUserSignedUp } from "@/telemetry/events/auth/user-signed-up";
import { NextResponse } from "next/server";

export const GET = withAmplio(async () => {
  useLogger()
    .event(AuthUserSignedUp)
    .set({ user: { id: "u_123" }, signup: { method: "email" } });
  return NextResponse.json({ ok: true });
});
```

## tRPC (v11)

When `init` detects `@trpc/server` alongside Next.js, it scaffolds `telemetry/middleware/trpc.ts` in addition to `telemetry/middleware/next.ts` (create-t3-app style: App Router + tRPC v11).

### Wiring (strict TypeScript)

**1. Route handler** — wrap the tRPC HTTP entry so the request wide event exists before procedures run:

```ts
// src/app/api/trpc/[trpc]/route.ts
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { withAmplio } from "../../../../../telemetry/middleware/next";
import { appRouter } from "@/server/api/root";
import { createTRPCContext } from "@/server/api/trpc";

const handler = (request: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: request.headers }),
  });

export const GET = withAmplio(handler);
export const POST = withAmplio(handler);
```

**2. tRPC init** — annotate the ambient request logger from procedures (no cast adapter):

```ts
// src/server/api/trpc.ts
import { amplioTrpcMiddleware } from "../../../telemetry/middleware/trpc";

const amplioMiddleware = t.middleware(amplioTrpcMiddleware());
export const publicProcedure = t.procedure.use(amplioMiddleware);
// repeat for protectedProcedure / other bases as needed
```

`amplioTrpcMiddleware()` is generic — `t.middleware(amplioTrpcMiddleware())` and `publicProcedure.use(...)` typecheck without casts under strict `tsconfig`.

### Model

- **`withAmplio`** owns the request wide event (the spine). It is named `event: "http.request"` / `@event: "http.request"` so you can filter all HTTP traffic on one key.
- **`amplioTrpcMiddleware`** annotates that spine with `trpc.path`, `trpc.type`, and HTTP status — it does not emit a sibling request row.
- **Domain events** you `.emit()` inside procedures (e.g. `auth.user.signed_up`) are separate rows. Keep business context on domain events; keep transport context on the spine.

### Errors

tRPC v11 returns `{ ok: false, error }` from `next()` instead of throwing for many procedure failures (including Zod input validation). The middleware inspects that result and annotates the spine via `.error()`: `error.message`, `error.name` (thrown class name), and `status` / `http.status` derived from the tRPC error code (`BAD_REQUEST` → 400, `UNAUTHORIZED` → 401, etc.). Thrown errors are handled the same way.

### Batching

With `httpBatchLink` / `httpBatchStreamLink`, multiple procedures share one HTTP request. The spine gets `trpc.batched: true` and `trpc.procedures: ["query post.hello", "mutation user.update", …]`; `trpc.path` / `trpc.type` stay on the **first** procedure in the batch. For clean per-procedure attribution, emit domain events inside each procedure rather than relying on the spine alone.

## shadcn registry

Hosted at https://amplio-ruddy.vercel.app

`init` writes `components.json` with:

```json
{
  "registries": {
    "@useamplio": "https://amplio-ruddy.vercel.app/r/{name}.json"
  }
}
```

Then:

```bash
npx shadcn@latest add @useamplio/sink-json
npx shadcn@latest add @useamplio/middleware-hono
```

Files land under `telemetry/…`.

## Packages

| Package | Role |
|---|---|
| `@useamplio/cli` | Scaffolding CLI (`npx @useamplio/cli@alpha`) |
| `@useamplio/amplio` | Runtime (`defineEvent`, `init`, `.set()`, `.emit()`) |

`@useamplio/core` is deprecated — use `@useamplio/amplio`.

## Feedback

- GitHub issues: https://github.com/alex-holovach/amplio/issues
- Include: framework, Node version, and the command you ran

## Skip auto-install

```bash
npx @useamplio/cli@alpha init --skip-install
pnpm add @useamplio/amplio zod
# or: npm install @useamplio/amplio zod  |  yarn add @useamplio/amplio zod
```
