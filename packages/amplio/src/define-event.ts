import { assertValidEventName } from "./event-name.js";
import type { DefineEventOptions, EventDef, EventShape } from "./types.js";

export function defineEvent<T extends Record<string, unknown>>(
  name: string,
  shape?: EventShape<T>,
  options?: DefineEventOptions,
): EventDef<T> {
  assertValidEventName(name);

  return {
    name,
    shape,
    skipValidation: options?.skipValidation ?? false,
  };
}
