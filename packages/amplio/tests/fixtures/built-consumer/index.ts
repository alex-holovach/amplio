import { z } from "zod";
import { event, type EventRecord } from "../../../dist/index.js";
import { plugin } from "../../../dist/plugin.js";

const EmailSend = event({
  id: "resend.send",
  version: 1,
  schema: z.object({
    template: z.string(),
    provider: z.literal("resend"),
  }),
  timing: "duration",
  cardinality: { many: { max: 4 } },
});

type SendInput = { template: { id: string }; to: string };
type SendResult = { id: string };
type Send = (input: SendInput) => Promise<SendResult>;

const ResendPlugin = plugin({
  id: "resend",
  events: { sends: EmailSend },
  instrument({ events, observe }) {
    return (send: Send): Send =>
      observe(events.sends, send, {
        input: ({ args: [input] }) => {
          const template: string = input.template.id;
          // @ts-expect-error Projector args retain the provider tuple.
          const wrong: number = input.template.id;
          void wrong;
          return { template, provider: "resend" };
        },
        result: ({ result }) => {
          const providerId: string = result.id;
          // @ts-expect-error Projector results do not degrade to any.
          void result.missing;
          void providerId;
          return undefined;
        },
      });
  },
});

const HttpRequest = event({
  id: "http.request",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    http: z.object({ method: z.string(), status: z.number() }),
  }),
  tree: {
    communication: {
      email: ResendPlugin.events,
    },
  },
});

const sendImplementation: Send = async () => ({ id: "email_1" });
const send = ResendPlugin(sendImplementation);
const exactSendFunction: Send = send;
void exactSendFunction;
// @ts-expect-error The Plugin preserves the provider input.
void send({ template: { id: "receipt" }, to: 123 });

const routeImplementation = async (request: {
  id: string;
  method: string;
}) => {
  await send({ template: { id: "receipt" }, to: "user@example.com" });
  return { status: 202 as const, request };
};

const route = HttpRequest.handle(routeImplementation, {
  input: ({ args: [request] }) => ({
    request_id: request.id,
    http: { method: request.method },
  }),
  result: ({ result }) => ({ http: { status: result.status } }),
  success: ({ result }) => result.status < 400,
});
const exactRouteFunction: typeof routeImplementation = route;
void exactRouteFunction;
// @ts-expect-error Event.handle preserves the implementation parameter.
void route({ id: "req_1", method: 123 });

type HttpRequestRecord = EventRecord<typeof HttpRequest>;
declare const record: HttpRequestRecord;
const eventId: "http.request" = record["@event"];
const version: 1 = record["@event_version"];
const requestId: string = record.request_id;
const template: string | undefined =
  record.communication?.email?.sends?.[0]?.template;
const sendSucceeded: boolean | undefined =
  record.communication?.email?.sends?.[0]?.success;
void [eventId, version, requestId, template, sendSucceeded];
// @ts-expect-error Nested schema fields retain their output types.
const wrongTemplate: number =
  record.communication?.email?.sends?.[0]?.template;
void wrongTemplate;

// @ts-expect-error Plugin authoring is intentionally absent from the runtime entry.
import { plugin as leakedPlugin } from "../../../dist/index.js";
void leakedPlugin;

// @ts-expect-error Legacy Logger is available only from the /legacy subpath.
import type { Logger } from "../../../dist/index.js";
void (undefined as unknown as Logger);
