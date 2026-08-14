# next-smoke

Minimal Next.js App Router route handler using an open-code framework Plugin with
`@useamplio/amplio`.

From monorepo root: `pnpm install && pnpm build && pnpm --filter @useamplio/example-next-smoke dev` — http://127.0.0.1:3003

`curl http://127.0.0.1:3003/api/health` — one `http.request` Event emits when the handler returns.

## Smoke

```bash
pnpm --filter @useamplio/example-next-smoke smoke
```

Starts `next dev` on an ephemeral port, verifies final success/failure status, stable route names,
and that query values never enter the Event.
