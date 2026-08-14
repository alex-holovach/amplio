import assert from "node:assert/strict";
import Fastify from "fastify";
import { init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { HttpRequest } from "./telemetry/events/http-request.js";
import { FastifyPlugin } from "./telemetry/plugins/fastify.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const app = Fastify();
await app.register(FastifyPlugin);
app.get<{ Params: { id: string } }>("/orders/:id", async (request, reply) => {
  await new Promise((resolve) =>
    setTimeout(resolve, request.params.id === "a" ? 8 : 1),
  );
  const failed = request.params.id === "b";
  return reply.code(failed ? 503 : 200).send({ ok: !failed });
});
await app.ready();
try {
  const [first, second] = await Promise.all([
    app.inject({
      method: "GET",
      url: "/orders/a?token=private-a@example.com",
      headers: { "x-request-id": "request-fastify-a" },
    }),
    app.inject({
      method: "GET",
      url: "/orders/b?token=private-b@example.com",
      headers: { "x-request-id": "request-fastify-b" },
    }),
  ]);
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 503);
} finally {
  await app.close();
}

const records = sink.all(HttpRequest);
assert.equal(records.length, 2);
for (const [requestId, status, success, secret] of [
  ["request-fastify-a", 200, true, "private-a@example.com"],
  ["request-fastify-b", 503, false, "private-b@example.com"],
] as const) {
  const record = records.find(
    (candidate) => candidate.request_id === requestId,
  );
  assert.ok(record);
  assert.equal(record.http.method, "GET");
  assert.equal(record.http.route, "/orders/:id");
  assert.equal(record.http.status, status);
  assert.equal(record.success, success);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
}
