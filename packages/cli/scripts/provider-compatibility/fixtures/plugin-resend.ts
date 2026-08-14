import assert from "node:assert/strict";
import { Resend } from "resend";
import { event, init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";
import { ResendPlugin } from "./telemetry/plugins/resend.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const Request = event({
  id: "compatibility.resend.request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { email: ResendPlugin.events },
});

const client = new Resend("re_private_key");
let nativeCalls = 0;
client.emails.send = (async () => {
  nativeCalls += 1;
  await new Promise((resolve) => setTimeout(resolve, nativeCalls % 2 ? 8 : 1));
  return { data: { id: `email-${nativeCalls}` }, error: null };
}) as typeof client.emails.send;
const instrumented = ResendPlugin(client);
assert.equal(instrumented, client);
assert.equal(ResendPlugin(instrumented), client);

async function send(requestId: string, secret: string): Promise<void> {
  const handle = Request.handle(
    async () => {
      const result = await instrumented.emails.send({
        from: "private-sender@example.com",
        to: secret,
        subject: `Private subject for ${secret}`,
        html: `<p>Private body for ${secret}</p>`,
        tags: [{ name: "template", value: "welcome" }],
      });
      assert.equal(result.error, null);
      assert.ok(result.data?.id);
    },
    { input: () => ({ request_id: requestId }) },
  );
  await handle();
}

await Promise.all([
  send("request-resend-a", "private-a@example.com"),
  send("request-resend-b", "private-b@example.com"),
]);
assert.equal(nativeCalls, 2);

const records = sink.all(Request);
assert.equal(records.length, 2);
for (const [requestId, secret] of [
  ["request-resend-a", "private-a@example.com"],
  ["request-resend-b", "private-b@example.com"],
] as const) {
  const record = records.find(
    (candidate) => candidate.request_id === requestId,
  );
  assert.ok(record);
  assert.equal(record.email?.sends?.length, 1);
  assert.equal(record.email?.sends?.[0]?.provider, "resend");
  assert.equal(record.email?.sends?.[0]?.template, "welcome");
  assert.equal(record.email?.sends?.[0]?.success, true);
  assert.equal(typeof record.email?.sends?.[0]?.duration_ms, "number");
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.doesNotMatch(
    serialized,
    /private-sender|Private subject|Private body/,
  );
}

sink.clear();
const inert = await instrumented.emails.send({
  from: "private-sender@example.com",
  to: "inert-private@example.com",
  subject: "Inert private subject",
  html: "<p>Inert private body</p>",
});
assert.equal(inert.error, null);
assert.equal(sink.all(Request).length, 0);
