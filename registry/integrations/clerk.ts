import type { WebhookEvent } from "@clerk/backend/webhooks";
import { logger } from "../logger";
import { AuthUserSignedIn } from "../events/auth/user-signed-in";
import { AuthUserSignedUp } from "../events/auth/user-signed-up";

export type ClerkWebhookEvent = WebhookEvent;

type ClerkUserPayload = {
  id: string;
  primary_email_address_id?: string | null;
  email_addresses?: Array<{ id: string; email_address: string }>;
  external_accounts?: Array<{ provider: string }>;
  enterprise_accounts?: Array<{ provider: string }>;
  password_enabled?: boolean;
  two_factor_enabled?: boolean;
  public_metadata?: Record<string, unknown> | null;
  unsafe_metadata?: Record<string, unknown> | null;
  private_metadata?: Record<string, unknown> | null;
};

type ClerkSessionPayload = {
  id: string;
  user_id: string;
  user: ClerkUserPayload | null;
};

export function trackClerkUserCreated(input: {
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

export function trackClerkSessionCreated(input: {
  user: { id: string; email?: string };
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

function clerkPrimaryEmail(user: ClerkUserPayload): string | undefined {
  const addresses = user.email_addresses ?? [];
  if (addresses.length === 0) {
    return undefined;
  }
  const primary = user.primary_email_address_id
    ? addresses.find((address) => address.id === user.primary_email_address_id)
    : addresses[0];
  return primary?.email_address;
}

function metadataReferrer(user: ClerkUserPayload): string | undefined {
  for (const metadata of [user.public_metadata, user.unsafe_metadata, user.private_metadata]) {
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    const referrer = metadata.referrer ?? metadata.referral;
    if (typeof referrer === "string" && referrer.length > 0) {
      return referrer;
    }
  }
  return undefined;
}

function metadataIndicatesInvite(user: ClerkUserPayload): boolean {
  for (const metadata of [user.public_metadata, user.unsafe_metadata, user.private_metadata]) {
    if (!metadata || typeof metadata !== "object") {
      continue;
    }
    if ("invitation_id" in metadata || "invite" in metadata || "invitationId" in metadata) {
      return true;
    }
  }
  return false;
}

function inferClerkSignUpMethod(user: ClerkUserPayload): "email" | "oauth" | "invite" {
  if (metadataIndicatesInvite(user)) {
    return "invite";
  }
  if ((user.external_accounts?.length ?? 0) > 0) {
    return "oauth";
  }
  return "email";
}

function inferClerkSignInMethod(user: ClerkUserPayload): "password" | "oauth" | "magic_link" | "sso" {
  if ((user.enterprise_accounts?.length ?? 0) > 0) {
    return "sso";
  }
  if ((user.external_accounts?.length ?? 0) > 0) {
    return "oauth";
  }
  if (user.password_enabled === false) {
    return "magic_link";
  }
  return "password";
}

function mapClerkUserCreated(data: ClerkUserPayload) {
  const email = clerkPrimaryEmail(data);
  if (!email) {
    return undefined;
  }
  const referrer = metadataReferrer(data);
  return trackClerkUserCreated({
    user: { id: data.id, email },
    method: inferClerkSignUpMethod(data),
    ...(referrer ? { referrer } : {}),
  });
}

function mapClerkSessionCreated(data: ClerkSessionPayload) {
  const user = data.user;
  const userId = user?.id ?? data.user_id;
  if (!userId) {
    return undefined;
  }
  const email = user ? clerkPrimaryEmail(user) : undefined;
  const signInMethod = user ? inferClerkSignInMethod(user) : "password";
  return trackClerkSessionCreated({
    user: {
      id: userId,
      ...(email ? { email } : {}),
    },
    session: {
      id: data.id,
      method: signInMethod,
      ...(user?.two_factor_enabled ? { mfa: true } : {}),
    },
  });
}

export function handleClerkWebhook(event: ClerkWebhookEvent) {
  switch (event.type) {
    case "user.created":
      return mapClerkUserCreated(event.data);
    case "session.created":
      return mapClerkSessionCreated(event.data);
    default:
      return undefined;
  }
}
