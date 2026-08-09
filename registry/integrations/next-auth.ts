/**
 * NextAuth (Auth.js v5) → amplio auth events.
 *
 * Wire into your NextAuth config (create-t3-app: src/server/auth/config.ts):
 *
 *   import { amplioNextAuthEvents } from "../../../telemetry/integrations/next-auth";
 *
 *   export const authConfig = {
 *     providers: [...],
 *     events: amplioNextAuthEvents(),
 *   } satisfies NextAuthConfig;
 *
 * These events fire inside the [...nextauth] route handler. Wrap that route
 * with withAmplio so the rows share the request spine's request_id — in a
 * stock create-t3-app layout `amplio init --yes` (or `init --wire`) does it:
 *
 *   // src/app/api/auth/[...nextauth]/route.ts
 *   const { GET: authGet, POST: authPost } = handlers;
 *   export const GET = withAmplio(authGet);
 *   export const POST = withAmplio(authPost);
 *
 * Uses structural types for the NextAuth event messages instead of importing
 * from next-auth (its v5 type exports are still beta-unstable).
 */
import { logger } from "../logger";
import { AuthUserSignedIn } from "../events/auth/user-signed-in";
import { AuthUserSignedUp } from "../events/auth/user-signed-up";

type NextAuthUser = {
  id?: string;
  email?: string | null;
};

type NextAuthAccount = {
  provider?: string;
  type?: string;
} | null;

export type NextAuthSignInMessage = {
  user: NextAuthUser;
  account?: NextAuthAccount;
  isNewUser?: boolean;
};

type SignInMethod = "password" | "oauth" | "magic_link" | "sso";

function signInMethod(account: NextAuthAccount | undefined): SignInMethod {
  switch (account?.type) {
    case "credentials":
      return "password";
    case "email":
      return "magic_link";
    default:
      // oidc / oauth / webauthn all reach the app via a provider flow.
      return "oauth";
  }
}

function userFields(user: NextAuthUser): { id: string; email?: string } | null {
  if (!user.id) {
    return null;
  }
  return { id: user.id, ...(user.email ? { email: user.email } : {}) };
}

export function trackNextAuthSignIn(message: NextAuthSignInMessage) {
  const user = userFields(message.user);
  if (!user) {
    return null;
  }

  // NextAuth fires one signIn event for both flows; isNewUser distinguishes a
  // first-time registration. Emit signed_up as an extra row so both funnels
  // stay queryable on their own event name.
  if (message.isNewUser) {
    logger
      .event(AuthUserSignedUp)
      .set({
        user,
        signup: {
          method: message.account?.type === "credentials" ? "email" : "oauth",
        },
      })
      .emit();
  }

  return logger
    .event(AuthUserSignedIn)
    .set({
      user,
      session: { method: signInMethod(message.account) },
    })
    .emit();
}

/**
 * Drop-in `events` object for NextAuth(config). Inside a withAmplio-wrapped
 * route these rows correlate with the http.request spine via request_id;
 * outside one they still emit as standalone rows.
 */
export function amplioNextAuthEvents() {
  return {
    signIn: (message: NextAuthSignInMessage) => {
      trackNextAuthSignIn(message);
    },
  };
}
