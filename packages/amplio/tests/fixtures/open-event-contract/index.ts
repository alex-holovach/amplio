import { event } from "@useamplio/amplio";
// @ts-expect-error openEvent is available only from the Plugin authoring subpath.
import { openEvent as mainOpenEvent } from "@useamplio/amplio";
// @ts-expect-error EventScope is available only from the Plugin authoring subpath.
import type { EventScope as MainEventScope } from "@useamplio/amplio";
import { openEvent, type EventScope } from "@useamplio/amplio/plugin";
import { z } from "zod";

const DurationBoundary = event({
  id: "contract.duration_boundary",
  version: 1,
  schema: z.object({
    request_id: z.string(),
    nested: z.object({
      left: z.string(),
      right: z.number(),
    }),
  }),
  timing: "duration",
});

const InstantEvent = event({
  id: "contract.instant_event",
  version: 1,
  schema: z.object({ label: z.string() }),
  timing: "instant",
});

const scope: EventScope<typeof DurationBoundary> = openEvent(DurationBoundary, {
  request_id: "req_1",
  nested: { left: "left" },
});

scope.update({ nested: { right: 1 } });
scope.finish({ nested: { left: "updated" } }, { success: true });
scope.fail(new Error("failed"), { nested: { right: 2 } });
scope.cancel("framework_cancelled");

const token = { source: "run" } as const;
const exactToken: typeof token = scope.run(() => token);

const callback = function (
  this: { prefix: string },
  input: { id: string },
  attempt: number,
): { value: string } {
  return { value: `${this.prefix}:${input.id}:${attempt}` };
};
const exactCallback: typeof callback = scope.bind(callback);

// @ts-expect-error openEvent accepts only duration Event definitions.
openEvent(InstantEvent, { label: "invalid" });
// @ts-expect-error EventScope models duration Event definitions only.
type InvalidInstantScope = EventScope<typeof InstantEvent>;
// @ts-expect-error Scope input retains the Event's deep input type.
scope.update({ nested: { right: "invalid" } });
// @ts-expect-error Scope input rejects undeclared fields.
scope.finish({ missing: true });

type _MainEventScope = MainEventScope;
void [mainOpenEvent, exactToken, exactCallback];
