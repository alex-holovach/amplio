import type { BetterAuthPlugin as NativeBetterAuthPlugin } from "better-auth";
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { event, init, type SinkRecord } from "@useamplio/amplio";
import { BetterAuthPlugin } from "../registry/plugins/better-auth.ts";

type AfterHook = NonNullable<
  NonNullable<NativeBetterAuthPlugin["hooks"]>["after"]
>[number];
type MatcherContext = Parameters<AfterHook["matcher"]>[0];
type HandlerContext = Parameters<AfterHook["handler"]>[0];

const AuthRequest = event({
  id: "test.auth_request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { auth: BetterAuthPlugin.events },
});

const PlainRequest = event({
  id: "test.plain_request",
  version: 1,
  schema: z.object({ request_id: z.string() }),
});

type ProviderContextOptions = {
  path: string;
  userId?: string;
  mfa?: boolean;
  returned?: unknown;
};

function providerContext({
  path,
  userId = "user_123",
  mfa,
  returned,
}: ProviderContextOptions) {
  const user = {
    id: userId,
    name: "Private Person",
    email: "private@example.com",
    emailVerified: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...(mfa === undefined ? {} : { twoFactorEnabled: mfa }),
  };
  const session = {
    id: "secret_session_id",
    token: "secret_session_token",
    userId,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
  const context = {
    path,
    method: "POST",
    body: {
      callbackURL: "https://private.example/callback",
      email: "body-private@example.com",
      invitationId: "secret_invitation_id",
      mfa: !mfa,
      referrer: "private-campaign",
      token: "secret_body_token",
    },
    query: { callbackURL: "https://private.example/query-callback" },
    params: { id: "private-provider" },
    headers: new Headers({ authorization: "Bearer secret_header_token" }),
    context: {
      newSession: { session, user },
      returned,
    },
  };

  return { context, session, user };
}

function afterHooks(candidate: NativeBetterAuthPlugin): AfterHook[] {
  return candidate.hooks?.after ?? [];
}

async function invokeMatchingHook(
  candidate: NativeBetterAuthPlugin,
  context: ReturnType<typeof providerContext>["context"],
): Promise<unknown> {
  const matching = afterHooks(candidate).filter((hook) =>
    hook.matcher(context as unknown as MatcherContext),
  );
  expect(matching).toHaveLength(1);
  return matching[0]!.handler(context as unknown as HandlerContext);
}

function initialize(records: SinkRecord[]): void {
  init({
    service: "auth-service",
    env: "test",
    sinks: [
      (record) => {
        records.push(record);
      },
    ],
  });
}

describe("BetterAuthPlugin", () => {
  it("is a callable native plugin with distinct single instant Events", () => {
    expectTypeOf(BetterAuthPlugin).toMatchTypeOf<
      () => NativeBetterAuthPlugin
    >();

    const nativePlugin: NativeBetterAuthPlugin = BetterAuthPlugin();
    expect(nativePlugin.id).toBe("amplio");
    expect(afterHooks(nativePlugin).length).toBeGreaterThan(0);
    expect(BetterAuthPlugin.events.signed_up).not.toBe(
      BetterAuthPlugin.events.signed_in,
    );
    expect(BetterAuthPlugin.events.signed_up).toMatchObject({
      id: "auth.signed_up",
      timing: "instant",
      cardinality: "single",
    });
    expect(BetterAuthPlugin.events.signed_in).toMatchObject({
      id: "auth.signed_in",
      timing: "instant",
      cardinality: "single",
    });
    expect(
      BetterAuthPlugin.events.signed_up.schema.safeParse({
        method: "password",
        user: { id: "user_123" },
      }).success,
    ).toBe(false);
    expect(
      BetterAuthPlugin.events.signed_in.schema.safeParse({
        method: "email",
        user: { id: "user_123" },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["/sign-up/email", undefined, "signed_up", "email", false, false],
    [
      "/organization/signup-with-invitation",
      undefined,
      "signed_up",
      "invite",
      false,
      false,
    ],
    [
      "/callback/github",
      { isRegister: true },
      "signed_up",
      "oauth",
      true,
      true,
    ],
    ["/sign-in/email", undefined, "signed_in", "password", true, true],
    ["/sign-in/username", undefined, "signed_in", "password", true, true],
    [
      "/callback/github",
      { isRegister: false },
      "signed_in",
      "oauth",
      false,
      false,
    ],
    [
      "/magic-link/verify",
      undefined,
      "signed_in",
      "magic_link",
      undefined,
      undefined,
    ],
    ["/sso/callback/acme", undefined, "signed_in", "sso", true, true],
    [
      "/two-factor/verify-totp",
      undefined,
      "signed_in",
      "password",
      undefined,
      true,
    ],
  ] as const)(
    "matches and records %s through the native after hook",
    async (path, returned, eventKey, method, configuredMfa, expectedMfa) => {
      const records: SinkRecord[] = [];
      initialize(records);
      const nativePlugin = BetterAuthPlugin();
      const fixture = providerContext({
        path,
        ...(returned === undefined ? {} : { returned }),
        ...(configuredMfa === undefined ? {} : { mfa: configuredMfa }),
      });

      const applicationResult = { ok: true } as const;
      const handle = AuthRequest.handle(
        async () => {
          const hookResult = await invokeMatchingHook(
            nativePlugin,
            fixture.context,
          );
          expect(hookResult).toBeUndefined();
          return applicationResult;
        },
        { input: () => ({ request_id: `request:${path}` }) },
      );

      await expect(handle()).resolves.toBe(applicationResult);
      expect(records).toHaveLength(1);
      const auth = records[0]?.auth as Record<string, unknown>;
      expect(auth).toEqual({
        [eventKey]: {
          method,
          user: { id: "user_123" },
          ...(expectedMfa === undefined ? {} : { mfa: expectedMfa }),
        },
      });

      const serialized = JSON.stringify(records[0]);
      for (const secret of [
        "private@example.com",
        "body-private@example.com",
        "secret_session_id",
        "secret_session_token",
        "secret_invitation_id",
        "private-campaign",
        "private.example/callback",
        "private.example/query-callback",
        "private-provider",
        "secret_body_token",
        "secret_header_token",
      ]) {
        expect(serialized).not.toContain(secret);
      }
    },
  );

  it("preserves provider context and is inert without the exact mounted Event", async () => {
    const records: SinkRecord[] = [];
    initialize(records);
    const nativePlugin = BetterAuthPlugin();
    const fixture = providerContext({
      path: "/sign-in/email",
      mfa: false,
    });
    const providerContextIdentity = fixture.context.context;

    await expect(
      invokeMatchingHook(nativePlugin, fixture.context),
    ).resolves.toBeUndefined();
    expect(records).toEqual([]);
    expect(fixture.context.context).toBe(providerContextIdentity);
    expect(fixture.context.context.newSession.session).toBe(fixture.session);
    expect(fixture.context.context.newSession.user).toBe(fixture.user);
    expect(fixture.context.context.newSession).toEqual({
      session: fixture.session,
      user: fixture.user,
    });

    const applicationResult = { status: 204 } as const;
    const handlePlainRequest = PlainRequest.handle(
      async () => {
        await invokeMatchingHook(nativePlugin, fixture.context);
        return applicationResult;
      },
      { input: () => ({ request_id: "plain_request" }) },
    );

    await expect(handlePlainRequest()).resolves.toBe(applicationResult);
    expect(records).toHaveLength(1);
    expect(records[0]).not.toHaveProperty("auth");
  });

  it("ignores unrelated or unconfirmed provider hooks", async () => {
    const nativePlugin = BetterAuthPlugin();
    const unrelated = providerContext({ path: "/reset-password" }).context;
    const unconfirmed = providerContext({
      path: "/sign-in/email",
      userId: "",
    }).context;

    expect(
      afterHooks(nativePlugin).filter((hook) =>
        hook.matcher(unrelated as unknown as MatcherContext),
      ),
    ).toEqual([]);
    expect(
      afterHooks(nativePlugin).filter((hook) =>
        hook.matcher(unconfirmed as unknown as MatcherContext),
      ),
    ).toEqual([]);
  });
});
