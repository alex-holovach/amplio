# amplio alpha guide

Schema-first wide-event telemetry that installs as open code in your repo.

**Status:** public alpha (`0.1.0-alpha.x`). APIs may change.

## Install (≈ 5 minutes)

From an existing Node 20+ app:

```bash
npx amplio@alpha init --service my-app --yes
```

That command:

1. Scaffolds `telemetry/` + `amplio.json` + `components.json`
2. Installs `@useamplio/amplio` and `zod`
3. Auto-detects Next.js / Hono / Express / Fastify and scaffolds middleware + a starter event when possible

Equivalent scoped form (same CLI):

```bash
npx @useamplio/cli@alpha init --service my-app --yes
```

### Hono

```bash
pnpm add hono
npx amplio@alpha init --service my-app --middleware hono --event auth.user.signed_up --yes
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
npx amplio@alpha init --service my-app --middleware next --event auth.user.signed_up --yes
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
| `amplio` | `npx amplio` entry (depends on CLI) |
| `@useamplio/cli` | Scaffolding CLI |
| `@useamplio/amplio` | Runtime (`defineEvent`, `init`, `.set()`, `.emit()`) |

`@useamplio/core` is deprecated — use `@useamplio/amplio`.

## Feedback

- GitHub issues: https://github.com/alex-holovach/amplio/issues
- Include: framework, Node version, and the command you ran

## Skip auto-install

```bash
npx amplio@alpha init --skip-install
pnpm add @useamplio/amplio zod
```
