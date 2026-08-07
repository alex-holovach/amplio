import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { getAccountCookie } from "better-auth/cookies";
import { logger } from "../logger";
import { AuthUserSignedIn } from "../events/auth/user-signed-in";
import { AuthUserSignedUp } from "../events/auth/user-signed-up";

type AuthHookContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

export function trackBetterAuthSignUp(input: {
  user: { id: string; email: string };
  method: "email" | "oauth" | "invite";
  referrer?: string;
}) {
  return logger
    .event(AuthUserSignedUp)
    .set({
      user: input.user,
      signup: {
        method: input.method,
        ...(input.referrer ? { referrer: input.referrer } : {}),
      },
    })
    .emit();
}

export function trackBetterAuthSignIn(input: {
  user: { id: string; email: string };
  session: { id: string; method: "password" | "oauth" | "magic_link" | "sso"; mfa?: boolean };
}) {
  return logger
    .event(AuthUserSignedIn)
    .set({
      user: input.user,
      session: input.session,
    })
    .emit();
}

function readBody(ctx: AuthHookContext): Record<string, unknown> {
  const body = ctx.body;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

function readUser(ctx: AuthHookContext): { id: string; email: string } | null {
  const user = ctx.context.newSession?.user;
  if (!user?.id || !user.email) {
    return null;
  }
  return { id: user.id, email: user.email };
}

function readReferrer(ctx: AuthHookContext): string | undefined {
  const body = readBody(ctx);
  const referrer = typeof body.referrer === "string" ? body.referrer : undefined;
  const callbackURL = typeof body.callbackURL === "string" ? body.callbackURL : undefined;
  return referrer ?? callbackURL;
}

function hasInvitationId(ctx: AuthHookContext): boolean {
  const body = readBody(ctx);
  return typeof body.invitationId === "string" && body.invitationId.length > 0;
}

function isSocialRegistration(ctx: AuthHookContext): boolean {
  const returned = ctx.context.returned;
  if (returned && typeof returned === "object" && "isRegister" in returned) {
    return Boolean((returned as { isRegister?: boolean }).isRegister);
  }
  return false;
}

function readMfa(ctx: AuthHookContext): boolean | undefined {
  const body = readBody(ctx);
  if (typeof body.mfa === "boolean") {
    return body.mfa;
  }
  const session = ctx.context.newSession?.session as { mfa?: boolean } | undefined;
  return session?.mfa;
}

async function readOAuthProvider(ctx: AuthHookContext): Promise<string | undefined> {
  const params = ctx.params as { id?: string } | undefined;
  if (typeof params?.id === "string") {
    return params.id;
  }
  try {
    const account = await getAccountCookie(ctx);
    return account?.providerId;
  } catch {
    return undefined;
  }
}

function trackSignUpFromContext(ctx: AuthHookContext, method: "email" | "oauth" | "invite") {
  const user = readUser(ctx);
  if (!user) {
    return;
  }
  trackBetterAuthSignUp({
    user,
    method,
    referrer: readReferrer(ctx),
  });
}

function trackSignInFromContext(
  ctx: AuthHookContext,
  method: "password" | "oauth" | "magic_link" | "sso",
) {
  const user = readUser(ctx);
  const session = ctx.context.newSession?.session;
  if (!user || !session?.id) {
    return;
  }
  const mfa = readMfa(ctx);
  trackBetterAuthSignIn({
    user,
    session: {
      id: session.id,
      method,
      ...(mfa !== undefined ? { mfa } : {}),
    },
  });
}

export function createBetterAuthLogcnPlugin(): BetterAuthPlugin {
  return {
    id: "logcn",
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email" && !!ctx.context.newSession?.user,
          handler: createAuthMiddleware(async (ctx) => {
            trackSignUpFromContext(ctx, hasInvitationId(ctx) ? "invite" : "email");
          }),
        },
        {
          matcher: (ctx) =>
            (ctx.path === "/organization/signup-with-invitation" ||
              ctx.path.endsWith("/signup-with-invitation")) &&
            !!ctx.context.newSession?.user,
          handler: createAuthMiddleware(async (ctx) => {
            trackSignUpFromContext(ctx, "invite");
          }),
        },
        {
          matcher: (ctx) =>
            ctx.path.startsWith("/callback/") &&
            !!ctx.context.newSession?.user &&
            isSocialRegistration(ctx),
          handler: createAuthMiddleware(async (ctx) => {
            await readOAuthProvider(ctx);
            trackSignUpFromContext(ctx, hasInvitationId(ctx) ? "invite" : "oauth");
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/sign-in/email" && !!ctx.context.newSession?.user,
          handler: createAuthMiddleware(async (ctx) => {
            trackSignInFromContext(ctx, "password");
          }),
        },
        {
          matcher: (ctx) =>
            ctx.path.startsWith("/callback/") &&
            !!ctx.context.newSession?.user &&
            !isSocialRegistration(ctx),
          handler: createAuthMiddleware(async (ctx) => {
            await readOAuthProvider(ctx);
            trackSignInFromContext(ctx, "oauth");
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/magic-link/verify" && !!ctx.context.newSession?.user,
          handler: createAuthMiddleware(async (ctx) => {
            trackSignInFromContext(ctx, "magic_link");
          }),
        },
        {
          matcher: (ctx) =>
            (ctx.path === "/sign-in/sso" ||
              ctx.path.startsWith("/sso/callback") ||
              ctx.path.startsWith("/sso/saml2/")) &&
            !!ctx.context.newSession?.user,
          handler: createAuthMiddleware(async (ctx) => {
            trackSignInFromContext(ctx, "sso");
          }),
        },
      ],
    },
  };
}
