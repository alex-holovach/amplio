import { logger } from "../logger";
import { EmailSent } from "../events/email/email-sent";

type ResendEmailEventData = {
  email_id: string;
  to: string[];
  subject: string;
  tags?: Record<string, string> | Array<{ name: string; value: string }>;
  template_id?: string;
};

export type ResendWebhookEvent = {
  type: "email.sent" | "email.delivered" | "email.bounced" | "email.complained";
  created_at?: string;
  data: ResendEmailEventData;
};

export function trackResendEmail(input: {
  message: { id: string; to: string; subject: string };
  template: string;
  status: "queued" | "sent" | "failed";
}) {
  return logger
    .event(EmailSent)
    .set({
      email: {
        id: input.message.id,
        template: input.template,
        to: input.message.to,
        subject: input.message.subject,
      },
      delivery: {
        provider: "resend",
        status: input.status,
      },
    })
    .emit();
}

function tagValue(
  tags: ResendEmailEventData["tags"],
  name: string,
): string | undefined {
  if (!tags) {
    return undefined;
  }
  if (Array.isArray(tags)) {
    return tags.find((entry) => entry.name === name)?.value;
  }
  return tags[name];
}

function templateFromTags(
  tags: ResendEmailEventData["tags"],
  templateId?: string,
): string {
  const tagged =
    tagValue(tags, "template") ??
    tagValue(tags, "category") ??
    tagValue(tags, "template_id") ??
    tagValue(tags, "templateId");
  if (tagged) {
    return tagged;
  }
  return templateId ?? "unknown";
}

function resendDeliveryStatus(
  type: ResendWebhookEvent["type"],
): "queued" | "sent" | "failed" {
  switch (type) {
    case "email.sent":
    case "email.delivered":
      return "sent";
    case "email.bounced":
    case "email.complained":
      return "failed";
    default:
      return "queued";
  }
}

export function handleResendWebhook(event: ResendWebhookEvent) {
  switch (event.type) {
    case "email.sent":
    case "email.delivered":
    case "email.bounced":
    case "email.complained": {
      const to = event.data.to[0];
      if (!to) {
        return undefined;
      }
      return trackResendEmail({
        message: {
          id: event.data.email_id,
          to,
          subject: event.data.subject,
        },
        template: templateFromTags(event.data.tags, event.data.template_id),
        status: resendDeliveryStatus(event.type),
      });
    }
    default:
      return undefined;
  }
}
