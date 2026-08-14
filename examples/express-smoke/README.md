# express-smoke

Minimal Express app using an open-code framework Plugin with `@useamplio/amplio`.

## Run

From the monorepo root:

```bash
pnpm install
pnpm build
pnpm --filter @useamplio/example-express-smoke dev
```

Try it:

```bash
curl http://127.0.0.1:3001/health
```

`GET /health` runs an ordinary async auth seam and the handler inside a first-in Event boundary.
One Event emits when the response finishes, contains `auth.check`, and includes auth time in the
root duration.

## Smoke

```bash
pnpm --filter @useamplio/example-express-smoke smoke
```

Starts the app, hits `GET /health`, asserts one JSON wide event with nested `http` and status 200.
