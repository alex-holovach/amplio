import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import type { BetterAuthPlugin as NativeBetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";

const AuthSession = {
  mfa: z.boolean().optional(),
  user: z.object({ id: z.string() }),
};

const SignedInResult = z.object({
  method: z.enum(["password", "oauth", "magic_link", "sso"]),
  ...AuthSession,
});

const SignedUpResult = z.object({
  method: z.enum(["email", "oauth", "invite"]),
  ...AuthSession,
});

type SignInMethod = z.infer<typeof SignedInResult>["method"];
type SignUpMethod = z.infer<typeof SignedUpResult>["method"];
type NativeAfterHook = NonNullable<
  NonNullable<NativeBetterAuthPlugin["hooks"]>["after"]
>[number];
type MatcherContext = Parameters<NativeAfterHook["matcher"]>[0];
type MiddlewareContext = Parameters<
  Parameters<typeof createAuthMiddleware>[0]
>[0];

function pathOf(context: MatcherContext): string {
  return typeof context.path === "string" ? context.path : "";
}

function hasConfirmedSession(context: MatcherContext): boolean {
  const id = context.context?.newSession?.user.id;
  return typeof id === "string" && id.length > 0;
}

function isRegistration(context: MatcherContext): boolean {
  const returned = context.context?.returned;
  if (returned === null || typeof returned !== "object") {
    return false;
  }

  try {
    return (returned as { isRegister?: unknown }).isRegister === true;
  } catch {
    return false;
  }
}

function isOAuthCallback(context: MatcherContext): boolean {
  const path = pathOf(context);
  return path.startsWith("/callback/") || path.startsWith("/oauth2/callback/");
}

function isEmailSignUp(context: MatcherContext): boolean {
  return pathOf(context) === "/sign-up/email" && hasConfirmedSession(context);
}

function isOAuthSignUp(context: MatcherContext): boolean {
  return (
    isOAuthCallback(context) &&
    hasConfirmedSession(context) &&
    isRegistration(context)
  );
}

function isInvitationSignUp(context: MatcherContext): boolean {
  const path = pathOf(context);
  return (
    (path === "/organization/signup-with-invitation" ||
      path.endsWith("/signup-with-invitation")) &&
    hasConfirmedSession(context)
  );
}

function isPasswordSignIn(context: MatcherContext): boolean {
  return (
    ["/sign-in/email", "/sign-in/username", "/sign-in/phone-number"].includes(
      pathOf(context),
    ) && hasConfirmedSession(context)
  );
}

function isOAuthSignIn(context: MatcherContext): boolean {
  return (
    isOAuthCallback(context) &&
    hasConfirmedSession(context) &&
    !isRegistration(context)
  );
}

function isMagicLinkSignIn(context: MatcherContext): boolean {
  return (
    pathOf(context) === "/magic-link/verify" && hasConfirmedSession(context)
  );
}

function isSsoSignIn(context: MatcherContext): boolean {
  const path = pathOf(context);
  return (
    (path === "/sign-in/sso" ||
      path.startsWith("/sso/callback") ||
      path.startsWith("/sso/saml2/")) &&
    hasConfirmedSession(context)
  );
}

function isMfaSignIn(context: MatcherContext): boolean {
  return (
    [
      "/two-factor/verify-totp",
      "/two-factor/verify-otp",
      "/two-factor/verify-backup-code",
    ].includes(pathOf(context)) && hasConfirmedSession(context)
  );
}

function projectSession(context: MiddlewareContext, forceMfa = false) {
  const session = context.context.newSession;
  if (!session?.user.id) {
    return;
  }

  const configuredMfa = session.user.twoFactorEnabled;
  const mfa = forceMfa
    ? true
    : typeof configuredMfa === "boolean"
      ? configuredMfa
      : undefined;

  return {
    user: { id: session.user.id },
    ...(mfa === undefined ? {} : { mfa }),
  };
}

export const BetterAuthPlugin = plugin({
  id: "better-auth",
  events: {
    signed_in: event({
      id: "auth.signed_in",
      version: 1,
      schema: SignedInResult,
      timing: "instant",
      cardinality: "single",
    }),
    signed_up: event({
      id: "auth.signed_up",
      version: 1,
      schema: SignedUpResult,
      timing: "instant",
      cardinality: "single",
    }),
  },
  instrument({ events, record }) {
    const recordSignedIn = (
      method: SignInMethod,
      context: MiddlewareContext,
      forceMfa = false,
    ): void => {
      const session = projectSession(context, forceMfa);
      if (!session) {
        return;
      }
      record(events.signed_in, { method, ...session });
    };

    const recordSignedUp = (
      method: SignUpMethod,
      context: MiddlewareContext,
    ): void => {
      const session = projectSession(context);
      if (!session) {
        return;
      }
      record(events.signed_up, { method, ...session });
    };

    return function createBetterAuthAdapter(): NativeBetterAuthPlugin {
      return {
        id: "amplio",
        hooks: {
          after: [
            {
              matcher: isEmailSignUp,
              handler: createAuthMiddleware(async (context) => {
                recordSignedUp("email", context);
              }),
            },
            {
              matcher: isInvitationSignUp,
              handler: createAuthMiddleware(async (context) => {
                recordSignedUp("invite", context);
              }),
            },
            {
              matcher: isOAuthSignUp,
              handler: createAuthMiddleware(async (context) => {
                recordSignedUp("oauth", context);
              }),
            },
            {
              matcher: isPasswordSignIn,
              handler: createAuthMiddleware(async (context) => {
                recordSignedIn("password", context);
              }),
            },
            {
              matcher: isOAuthSignIn,
              handler: createAuthMiddleware(async (context) => {
                recordSignedIn("oauth", context);
              }),
            },
            {
              matcher: isMagicLinkSignIn,
              handler: createAuthMiddleware(async (context) => {
                recordSignedIn("magic_link", context);
              }),
            },
            {
              matcher: isSsoSignIn,
              handler: createAuthMiddleware(async (context) => {
                recordSignedIn("sso", context);
              }),
            },
            {
              matcher: isMfaSignIn,
              handler: createAuthMiddleware(async (context) => {
                recordSignedIn("password", context, true);
              }),
            },
          ],
        },
      };
    };
  },
});
