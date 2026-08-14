import assert from "node:assert/strict";
import { Hono } from "hono";
import { init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { HttpRequest } from "./telemetry/events/http-request.js";
import { HonoPlugin } from "./telemetry/plugins/hono.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const app = new Hono();
app.use("*", HonoPlugin());
app.get("/orders/:id", async (context) => {
  await new Promise((resolve) =>
    setTimeout(resolve, context.req.param("id") === "a" ? 8 : 1),
  );
  const failed = context.req.param("id") === "b";
  return context.json({ ok: !failed }, failed ? 503 : 200);
});

const [first, second] = await Promise.all([
  app.request("/orders/a?token=private-a@example.com", {
    headers: { "x-request-id": "request-hono-a" },
  }),
  app.request("/orders/b?token=private-b@example.com", {
    headers: { "x-request-id": "request-hono-b" },
  }),
]);
assert.equal(first.status, 200);
assert.equal(second.status, 503);

const records = sink.all(HttpRequest);
assert.equal(records.length, 2);
for (const [requestId, status, success, secret] of [
  ["request-hono-a", 200, true, "private-a@example.com"],
  ["request-hono-b", 503, false, "private-b@example.com"],
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
