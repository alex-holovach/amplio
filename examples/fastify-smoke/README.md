# fastify-smoke

Minimal Fastify app using an open-code lifecycle Plugin with `@useamplio/amplio`.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @useamplio/example-fastify-smoke dev
```

Try it:

```bash
curl http://127.0.0.1:3002/health
```

`GET /health` produces one Event when the response finishes.

## Smoke

```bash
pnpm --filter @useamplio/example-fastify-smoke smoke
```

Starts the app through the lifecycle Plugin, hits `GET /health` and a route whose `onSend` hook
changes the final status to 503, then verifies both Events use the final response status.
