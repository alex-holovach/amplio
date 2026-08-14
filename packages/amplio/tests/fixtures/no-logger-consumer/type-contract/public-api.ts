import { event, type EventRecord } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";

const Observation = event({
  id: "type.observation",
  version: 1,
  schema: z.object({ value: z.string() }),
  timing: "instant",
  cardinality: { many: { max: 10 } },
});
const ExamplePlugin = plugin({
  id: "type-example",
  events: { observations: Observation },
  instrument({ events }) {
    void events.observations;
    return () => undefined;
  },
});
const Root = event({
  id: "type.root",
  version: 1,
  schema: z.object({ request_id: z.string() }),
  tree: { plugin: ExamplePlugin.events },
});

declare const record: EventRecord<typeof Root>;
const value: string | undefined = record.plugin?.observations?.[0]?.value;
void value;

// Plugin authoring is intentionally available only from the authoring subpath.
// @ts-expect-error plugin is not part of the runtime entrypoint.
import { plugin as leakedPlugin } from "@useamplio/amplio";
void leakedPlugin;

// The builder interface is intentionally available only from a legacy subpath.
// @ts-expect-error Logger is not part of the Event-first main entrypoint.
import type { Logger } from "@useamplio/amplio";

// @ts-expect-error EventLogger is not part of the Event-first main entrypoint.
import type { EventLogger } from "@useamplio/amplio";

// @ts-expect-error LoggerFacade is not part of the Event-first main entrypoint.
import type { LoggerFacade } from "@useamplio/amplio";
