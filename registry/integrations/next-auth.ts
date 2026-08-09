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

export type NextAuthCreateUserMessage = {
  user: NextAuthUser;
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

// `createUser` (adapter created a user row) is the reliable "signed up"
// signal — `isNewUser` on signIn is not set for database-session credential
// flows. createUser has no account, though, so it cannot name the signup
// method; instead of emitting a half-empty row here we mark the id and let
// the signIn event (which fires right after, with the account) emit
// auth.user.signed_up exactly once with the real method. Bounded so a
// long-lived process never grows it past ~1000 ids.
const newlyCreatedUserIds = new Set<string>();
const NEWLY_CREATED_CAP = 1000;

export function trackNextAuthCreateUser(message: NextAuthCreateUserMessage): void {
  const user = userFields(message.user);
  if (!user) {
    return;
  }
  if (newlyCreatedUserIds.size >= NEWLY_CREATED_CAP) {
    newlyCreatedUserIds.clear();
  }
  newlyCreatedUserIds.add(user.id);
}

export function trackNextAuthSignIn(message: NextAuthSignInMessage) {
  const user = userFields(message.user);
  if (!user) {
    return null;
  }

  // NextAuth fires one signIn event for both flows; isNewUser (or a
  // createUser event seen just before) distinguishes a first-time
  // registration. Emit signed_up as an extra row so both funnels stay
  // queryable on their own event name.
  const isNewUser = message.isNewUser === true || newlyCreatedUserIds.has(user.id);
  newlyCreatedUserIds.delete(user.id);
  if (isNewUser) {
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
 *
 * Covered: signIn (auth.user.signed_in) and createUser + signIn
 * (auth.user.signed_up — reliable even when isNewUser is not set, e.g.
 * database-session credential flows).
 *
 * Not covered by default — this file is open code, extend it in place:
 *
 *   signOut: NextAuth's message shape depends on session strategy
 *   ({ token } for JWT, { session } for database). Scaffold an event with
 *   `amplio add event auth.user.signed_out`, then add:
 *
 *     signOut: (message: { token?: { sub?: string } | null }) => {
 *       const id = message.token?.sub;
 *       if (id) {
 *         logger.event(AuthUserSignedOut).set({ user: { id } }).emit();
 *       }
 *     },
 *
 *   linkAccount: fires when an OAuth account is linked to an existing user
 *   (message: { user, account }). Scaffold `amplio add event
 *   auth.account.linked` and emit `{ user, account: { provider } }` the same
 *   way.
 */
export function amplioNextAuthEvents() {
  return {
    createUser: (message: NextAuthCreateUserMessage) => {
      trackNextAuthCreateUser(message);
    },
    signIn: (message: NextAuthSignInMessage) => {
      trackNextAuthSignIn(message);
    },
  };
}
