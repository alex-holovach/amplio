import assert from "node:assert/strict";
import express from "express";
import { init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { HttpRequest } from "./telemetry/events/http-request.js";
import { withAmplioRoute } from "./telemetry/plugins/express.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const app = express();
app.get(
  "/orders/:id",
  ...withAmplioRoute("orders.show", (request, response) => {
    const failed = request.params.id === "b";
    setTimeout(
      () => {
        response.statusCode = failed ? 503 : 200;
        response.end(JSON.stringify({ ok: !failed }));
      },
      failed ? 1 : 8,
    );
  }),
);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
try {
  const [first, second] = await Promise.all([
    fetch(
      `http://127.0.0.1:${address.port}/orders/a?token=private-a@example.com`,
      { headers: { "x-request-id": "request-express-a" } },
    ),
    fetch(
      `http://127.0.0.1:${address.port}/orders/b?token=private-b@example.com`,
      { headers: { "x-request-id": "request-express-b" } },
    ),
  ]);
  assert.equal(first.status, 200);
  assert.equal(second.status, 503);
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const records = sink.all(HttpRequest);
assert.equal(records.length, 2);
for (const [requestId, status, success, secret] of [
  ["request-express-a", 200, true, "private-a@example.com"],
  ["request-express-b", 503, false, "private-b@example.com"],
] as const) {
  const record = records.find(
    (candidate) => candidate.request_id === requestId,
  );
  assert.ok(record);
  assert.equal(record.http.method, "GET");
  assert.equal(record.http.route, "orders.show");
  assert.equal(record.http.status, status);
  assert.equal(record.success, success);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(secret));
}
