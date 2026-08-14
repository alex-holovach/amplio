import assert from "node:assert/strict";
import { initTRPC } from "@trpc/server";
import { event, init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";
import { TrpcPlugin } from "./telemetry/plugins/trpc.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const Request = event({
  id: "compatibility.trpc.request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { rpc: TrpcPlugin.events },
});

const t = initTRPC.context<{ privateContext: string }>().create();
const amplioMiddleware = t.middleware(TrpcPlugin());
const router = t.router({
  lookup: t.procedure
    .input(z.object({ privateInput: z.string() }))
    .use(amplioMiddleware)
    .query(({ ctx, input }) => ({
      context: ctx.privateContext,
      input: input.privateInput,
    })),
  fail: t.procedure.use(amplioMiddleware).mutation(() => {
    throw new Error("private provider failure");
  }),
});

async function runRequest(requestId: string, secret: string): Promise<void> {
  const caller = router.createCaller({ privateContext: `context:${secret}` });
  const handle = Request.handle(
    async () => {
      const result = await caller.lookup({ privateInput: `input:${secret}` });
      assert.deepEqual(result, {
        context: `context:${secret}`,
        input: `input:${secret}`,
      });
      await assert.rejects(caller.fail(), /private provider failure/);
    },
    { input: () => ({ request_id: requestId }) },
  );
  await handle();
}

await Promise.all([
  runRequest("request-trpc-a", "secret-a@example.com"),
  runRequest("request-trpc-b", "secret-b@example.com"),
]);

const records = sink.all(Request);
assert.equal(records.length, 2);
for (const [requestId, secret] of [
  ["request-trpc-a", "secret-a@example.com"],
  ["request-trpc-b", "secret-b@example.com"],
] as const) {
  const record = records.find(
    (candidate) => candidate.request_id === requestId,
  );
  assert.ok(record);
  assert.equal(record.rpc?.procedures?.length, 2);
  assert.deepEqual(
    record.rpc?.procedures?.map(({ path, type, success }) => ({
      path,
      type,
      success,
    })),
    [
      { path: "lookup", type: "query", success: true },
      { path: "fail", type: "mutation", success: false },
    ],
  );
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(record), /private provider failure/);
}

sink.clear();
const inertCaller = router.createCaller({ privateContext: "inert-secret" });
assert.deepEqual(await inertCaller.lookup({ privateInput: "inert-input" }), {
  context: "inert-secret",
  input: "inert-input",
});
assert.equal(sink.all(Request).length, 0);
