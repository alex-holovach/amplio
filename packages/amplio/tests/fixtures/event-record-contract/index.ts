import { event, type EventRecord, type Schema } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Condition extends true> = Condition;

const ProviderEntry = event({
  id: "provider.entry",
  version: 1,
  schema: z.object({ value: z.string() }),
  timing: "instant",
});

const ProviderPlugin = plugin({
  id: "provider",
  events: { entry: ProviderEntry },
  instrument({ events, record }) {
    return (value: string): void => record(events.entry, { value });
  },
});

const CollisionRoot = event({
  id: "contract.collision_root",
  version: 1,
  schema: z.object({ semantic: z.string() }).transform((value) => ({
    ...value,
    service: "schema-service" as const,
    provider: "schema-provider" as const,
  })),
  tree: { provider: ProviderPlugin.events },
});

type CollisionRecord = EventRecord<typeof CollisionRoot>;
declare const collisionRecord: CollisionRecord;

type RuntimeServiceOwnsCollision = Expect<
  Equal<CollisionRecord["service"], string>
>;
void (undefined as unknown as RuntimeServiceOwnsCollision);

const service: string = collisionRecord.service;
const providerValue: string | undefined =
  collisionRecord.provider?.entry?.value;
const validProviderBranch: NonNullable<CollisionRecord["provider"]> = {
  entry: { value: "provider-value" },
};
void [service, providerValue, validProviderBranch];

// Runtime envelope fields must not retain colliding schema literals.
// @ts-expect-error service belongs to the runtime envelope, not schema output.
const schemaService: "schema-service" = collisionRecord.service;
void schemaService;

// Mounted tree keys must not retain colliding schema literals.
// @ts-expect-error provider belongs to the mounted Plugin branch.
const schemaProvider: "schema-provider" = collisionRecord.provider;
void schemaProvider;

const JsonObject = event({
  id: "contract.json_object",
  version: 1,
  schema: z.object({
    message: z.string(),
    count: z.number(),
    active: z.boolean(),
    tags: z.array(z.string()),
    context: z.object({ nullable: z.null() }),
  }),
});

const JsonTransform = event({
  id: "contract.json_transform",
  version: 1,
  schema: z.object({ raw: z.string() }).transform(({ raw }) => ({
    normalized: raw.trim().toUpperCase(),
    attributes: { attempts: 1, cached: false },
    labels: ["json"],
    reason: null,
  })),
});

declare const jsonObjectRecord: EventRecord<typeof JsonObject>;
declare const jsonTransformRecord: EventRecord<typeof JsonTransform>;
const message: string = jsonObjectRecord.message;
const normalized: string = jsonTransformRecord.normalized;
void [message, normalized];

// Delivered records are deeply frozen, so their public types must reject the
// same mutations before a sink reaches runtime.
// @ts-expect-error nested EventRecord arrays are deeply readonly.
jsonObjectRecord.tags.push("mutation");
// @ts-expect-error nested EventRecord objects are deeply readonly.
jsonTransformRecord.attributes.attempts = 2;
// @ts-expect-error mounted Plugin outputs are deeply readonly.
collisionRecord.provider!.entry!.value = "mutation";

// Event schema output is a sink-bound wire contract and must be JSON-safe.
const NonJsonOutput = event({
  id: "contract.non_json",
  version: 1,
  // @ts-expect-error Date output is not JSON-serializable Event output.
  schema: z.object({ created_at: z.date() }),
});
void NonJsonOutput;

const requiredUndefinedSchema: Schema<
  { missing: undefined },
  { missing: undefined }
> = {
  "~standard": {
    version: 1,
    vendor: "event-record-contract",
    validate: () => ({ value: { missing: undefined } }),
  },
};
const RequiredUndefined = event({
  id: "contract.required_undefined",
  version: 1,
  // @ts-expect-error Required undefined fields disappear during serialization.
  schema: requiredUndefinedSchema,
});
void RequiredUndefined;

const UndefinedArray = event({
  id: "contract.undefined_array",
  version: 1,
  // @ts-expect-error Undefined array entries serialize as null.
  schema: z.object({ entries: z.array(z.undefined()) }),
});
void UndefinedArray;
