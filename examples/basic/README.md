# example-basic

Minimal Hono app showing one request Event assembled by open-code Plugins.

## What this demonstrates

- `telemetry/events/http-request.ts` declares the complete request Event tree
- `telemetry/plugins/hono.ts` owns the real Hono request lifecycle
- `telemetry/plugins/signup.ts` wraps one ordinary function at its exported seam
- `telemetry/runtime.ts` only configures sinks and calls `init()`
- Handlers and domain calls contain no logger, `.set()`, `.emit()`, or telemetry mutation

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @useamplio/example-basic dev
```

Try it:

```bash
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/signup
```

Each request prints one JSON wide event to stdout.

## Smoke

```bash
pnpm --filter @useamplio/example-basic smoke
```

Starts the Hono app and verifies success, returned-failure, thrown-error, and sign-up Events. The
sign-up request contains `auth.signed_up` inside the single `http.request` record.
