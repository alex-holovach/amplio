import assert from "node:assert/strict";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { event, init } from "@useamplio/amplio";
import { createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";
import { BetterAuthPlugin } from "./telemetry/plugins/better-auth.js";

const sink = createTestSink();
init({ service: "provider-compatibility", env: "test", sinks: [sink] });

const AuthRequest = event({
  id: "compatibility.auth.request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { auth: BetterAuthPlugin.events },
});

const auth = betterAuth({
  baseURL: "http://localhost:3000",
  database: memoryAdapter({
    account: [],
    session: [],
    user: [],
    verification: [],
  }),
  emailAndPassword: { enabled: true },
  plugins: [BetterAuthPlugin()],
  secret: "compatibility-secret-at-least-thirty-two-characters",
});

async function runAuthLifecycle(
  requestId: string,
  email: string,
  password: string,
): Promise<void> {
  const handle = AuthRequest.handle(
    async () => {
      const signedUp = await auth.api.signUpEmail({
        body: { email, name: `Private ${requestId}`, password },
      });
      assert.ok(signedUp.user.id);
      assert.equal(signedUp.user.email, email);

      const signedIn = await auth.api.signInEmail({
        body: { email, password },
      });
      assert.equal(signedIn.user.id, signedUp.user.id);
    },
    { input: () => ({ request_id: requestId }) },
  );
  await handle();
}

await Promise.all([
  runAuthLifecycle(
    "request-auth-a",
    "private-a@example.com",
    "private-password-a",
  ),
  runAuthLifecycle(
    "request-auth-b",
    "private-b@example.com",
    "private-password-b",
  ),
]);

const records = sink.all(AuthRequest);
assert.equal(records.length, 2);
for (const [requestId, email, password] of [
  ["request-auth-a", "private-a@example.com", "private-password-a"],
  ["request-auth-b", "private-b@example.com", "private-password-b"],
] as const) {
  const record = records.find(
    (candidate) => candidate.request_id === requestId,
  );
  assert.ok(record);
  const authRecord = record.auth as
    | {
        signed_up?: { method?: string; user?: { id?: string } };
        signed_in?: { method?: string; user?: { id?: string } };
      }
    | undefined;
  const signedUp = authRecord?.signed_up;
  const signedIn = authRecord?.signed_in;
  assert.ok(signedUp?.user);
  assert.ok(signedIn?.user);
  assert.equal(signedUp.method, "email");
  assert.equal(signedIn.method, "password");
  assert.ok(signedUp.user.id);
  assert.equal(signedIn.user.id, signedUp.user.id);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, new RegExp(email));
  assert.doesNotMatch(serialized, new RegExp(password));
  assert.doesNotMatch(serialized, /token|session/i);
}

sink.clear();
const inert = await auth.api.signUpEmail({
  body: {
    email: "inert-private@example.com",
    name: "Inert Private User",
    password: "inert-private-password",
  },
});
assert.ok(inert.user.id);
assert.equal(sink.all(AuthRequest).length, 0);
