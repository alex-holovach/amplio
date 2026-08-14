import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import type { CreateEmailOptions, Resend } from "resend";
import { z } from "zod";

const ResendSend = event({
  id: "resend.send",
  version: 1,
  schema: z.object({
    provider: z.literal("resend"),
    template: z.string().optional(),
  }),
  timing: "duration",
  cardinality: { many: { max: 16 } },
});

const templateTag = (input: CreateEmailOptions): string | undefined =>
  input.tags?.find((tag) => tag.name === "template")?.value;

const instrumentedClients = new WeakSet<Resend>();

export const ResendPlugin = plugin({
  id: "resend",
  events: { sends: ResendSend },
  instrument({ events, observe }) {
    return <Client extends Resend>(client: Client): Client => {
      if (instrumentedClients.has(client)) {
        return client;
      }

      const send = client.emails.send.bind(client.emails);
      client.emails.send = observe(events.sends, send, {
        input: ({ args: [input] }) => {
          const template = templateTag(input);
          return {
            provider: "resend",
            ...(template ? { template } : {}),
          };
        },
        success: ({ result }) => result.error === null,
      });
      instrumentedClients.add(client);
      return client;
    };
  },
});
