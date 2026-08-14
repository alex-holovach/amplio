import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { HttpRequest } from "./telemetry/events/http-request.js";
import { withAmplio } from "./telemetry/plugins/next.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const handler = withAmplio("orders.show", async (request: NextRequest) => {
  const failed = request.nextUrl.pathname.endsWith("/b");
  await new Promise((resolve) => setTimeout(resolve, failed ? 1 : 8));
  return new Response(JSON.stringify({ ok: !failed }), {
    status: failed ? 503 : 200,
  });
});

const [first, second] = await Promise.all([
  handler(
    new NextRequest("http://localhost/orders/a?token=private-a@example.com", {
      headers: { "x-request-id": "request-next-a" },
    }),
  ),
  handler(
    new NextRequest("http://localhost/orders/b?token=private-b@example.com", {
      headers: { "x-request-id": "request-next-b" },
    }),
  ),
]);
assert.equal(first.status, 200);
assert.equal(second.status, 503);

const records = sink.all(HttpRequest);
assert.equal(records.length, 2);
for (const [requestId, status, success, secret] of [
  ["request-next-a", 200, true, "private-a@example.com"],
  ["request-next-b", 503, false, "private-b@example.com"],
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
