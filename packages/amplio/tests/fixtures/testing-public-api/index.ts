import { event, type EventRecord, type Sink } from "@useamplio/amplio";
import { assertEvent, createTestSink } from "@useamplio/amplio/testing";
import { z } from "zod";

const ProviderCall = event({
  id: "typing.provider_call",
  version: 1,
  schema: z.object({ provider_id: z.string() }),
  timing: "duration",
  cardinality: { many: { max: 3 } },
});

const Request = event({
  id: "typing.request",
  version: 2,
  schema: z.object({
    request_id: z.string(),
    http: z.object({ status: z.number().int() }),
  }),
  tree: { provider: { calls: ProviderCall } },
});

const events = createTestSink();
const configuredSink: Sink = events;
const record = events.single(Request);
const records = events.all(Request);

type IsAny<Value> = 0 extends 1 & Value ? true : false;
const recordIsNotAny: false = false as IsAny<typeof record>;
const exactRecord: EventRecord<typeof Request> = record;
const exactRecords: readonly EventRecord<typeof Request>[] = records;
const eventId: "typing.request" = record["@event"];
const eventVersion: 2 = record["@event_version"];
const requestId: string = record.request_id;
const status: number = record.http.status;
const providerId: string | undefined = record.provider?.calls?.[0]?.provider_id;
const providerSuccess: boolean | undefined =
  record.provider?.calls?.[0]?.success;

// @ts-expect-error Schema output fields retain their exact types.
const wrongStatus: string = record.http.status;
// @ts-expect-error Repeated nested Events remain arrays.
const wrongCalls: { provider_id: string } | undefined = record.provider?.calls;

let candidate: unknown = JSON.parse("{}");
assertEvent(Request, candidate);
const narrowed: EventRecord<typeof Request> = candidate;
const narrowedStatus: number = candidate.http.status;

const diagnosticCode: string | undefined = events.diagnostics[0]?.code;
const diagnosticEvent: string | undefined = events.diagnostics[0]?.event;
const cleared: void = events.clear();
const asserted: void = events.assertNoDiagnostics();

// @ts-expect-error assertEvent requires an Event definition, not an ID string.
assertEvent("typing.request", candidate);

// @ts-expect-error Testing helpers do not leak from the runtime entrypoint.
import { createTestSink as leakedCreateTestSink } from "@useamplio/amplio";

void [
  configuredSink,
  recordIsNotAny,
  exactRecord,
  exactRecords,
  eventId,
  eventVersion,
  requestId,
  status,
  providerId,
  providerSuccess,
  wrongStatus,
  wrongCalls,
  narrowed,
  narrowedStatus,
  diagnosticCode,
  diagnosticEvent,
  cleared,
  asserted,
  leakedCreateTestSink,
];
