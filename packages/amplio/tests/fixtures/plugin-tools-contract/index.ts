import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";

const OwnedInstant = event({
  id: "contract.owned_instant",
  version: 1,
  schema: z.object({ label: z.string() }),
  timing: "instant",
});

const OwnedDuration = event({
  id: "contract.owned_duration",
  version: 1,
  schema: z.object({
    operation: z.string(),
    detail: z.object({ attempt: z.number().int().optional() }),
  }),
  timing: "duration",
});

const UnownedInstant = event({
  id: "contract.unowned_instant",
  version: 1,
  schema: z.object({ label: z.string() }),
  timing: "instant",
});

const UnownedDuration = event({
  id: "contract.unowned_duration",
  version: 1,
  schema: z.object({
    operation: z.string(),
    detail: z.object({ attempt: z.number().int().optional() }),
  }),
  timing: "duration",
});

const ContractPlugin = plugin({
  id: "contract",
  events: {
    instant: OwnedInstant,
    duration: OwnedDuration,
  },
  instrument({ events, record, observe, begin }) {
    record(events.instant, { label: "accepted" });

    const implementation = function (
      this: { prefix: string },
      input: { id: string },
      attempt: number,
    ): Promise<{ ok: true }> {
      void [this.prefix, input.id, attempt];
      return Promise.resolve({ ok: true });
    };
    const observed = observe(events.duration, implementation, {
      input: ({ args: [input, attempt] }) => {
        const id: string = input.id;
        const count: number = attempt;
        // @ts-expect-error Projector arguments retain the function tuple.
        const wrong: number = input.id;
        void [id, count, wrong];
        return { operation: "observe", detail: { attempt } };
      },
      result: ({ result }) => {
        const ok: true = result.ok;
        // @ts-expect-error Settled results do not degrade to any.
        void result.missing;
        void ok;
        return undefined;
      },
      error: ({ error }) => {
        // @ts-expect-error Application errors remain unknown.
        void error.message;
        return undefined;
      },
    });
    const exactObserved: typeof implementation = observed;

    const handle = begin(events.duration, {
      operation: "begin",
      detail: { attempt: 1 },
    });
    handle.update({ detail: { attempt: 2 } });
    handle.end({ operation: "ended" }, { success: true });
    handle.fail(new Error("failed"), { operation: "failed" });
    handle.cancel("provider_cancelled");

    const runToken = { source: "run" } as const;
    const exactRunToken: typeof runToken = handle.run(() => runToken);
    const bound = handle.bind(implementation);
    const exactBound: typeof implementation = bound;

    // @ts-expect-error record() accepts only instant Events from this Plugin.
    record(events.duration, { operation: "invalid", detail: {} });
    // @ts-expect-error record() rejects an instant Event owned by another Plugin.
    record(UnownedInstant, { label: "invalid" });
    // @ts-expect-error record() retains the owned Event input schema.
    record(events.instant, { label: 123 });

    // @ts-expect-error observe() accepts only duration Events from this Plugin.
    observe(events.instant, implementation, {});
    // @ts-expect-error observe() rejects a duration Event owned by another Plugin.
    observe(UnownedDuration, implementation, {});

    // @ts-expect-error begin() accepts only duration Events from this Plugin.
    begin(events.instant);
    // @ts-expect-error begin() rejects a duration Event owned by another Plugin.
    begin(UnownedDuration);
    // @ts-expect-error begin() retains the owned Event input schema.
    begin(events.duration, { detail: { attempt: "invalid" } });
    // @ts-expect-error Handle updates retain the owned Event input schema.
    handle.update({ detail: { attempt: "invalid" } });

    void [exactObserved, exactRunToken, exactBound];
    return () => observed;
  },
});

void ContractPlugin;

function overloadedProvider(
  input: string,
  callback: (value: string | number) => void,
): string;
function overloadedProvider(
  input: number,
  callback: (value: string | number) => void,
): number;
function overloadedProvider(
  input: string | number,
  callback: (value: string | number) => void,
): string | number {
  callback(input);
  return input;
}

const OverloadedCall = event({
  id: "contract.overloaded_call",
  version: 1,
  schema: z.object({}),
  timing: "duration",
});

const OverloadedPlugin = plugin({
  id: "contract-overloaded",
  events: { call: OverloadedCall },
  instrument({ events, observe }) {
    return (fn: typeof overloadedProvider): typeof overloadedProvider =>
      observe(events.call, fn);
  },
});

const observedOverload = OverloadedPlugin(overloadedProvider);
const observedString: string = observedOverload("string", () => undefined);
const observedNumber: number = observedOverload(42, () => undefined);

const OverloadedRoot = event({
  id: "contract.overloaded_root",
  version: 1,
  schema: z.object({}),
  tree: { provider: OverloadedPlugin.events },
});
const handledOverload = OverloadedRoot.handle(overloadedProvider);
const handledString: string = handledOverload("string", () => undefined);
const handledNumber: number = handledOverload(42, () => undefined);
void [observedString, observedNumber, handledString, handledNumber];
