import { eventNameToExport } from "../utils/event-name.js";

/** Editable duration-root Event with stable Plugin composition markers. */
export function renderEventTemplate(
  eventName: string,
  exportName = eventNameToExport(eventName),
): string {
  return `import { event } from "@useamplio/amplio";
import { z } from "zod";
// amplio:plugin-imports

export const ${exportName} = event({
  id: "${eventName}",
  version: 1,
  schema: z.object({
    // Add bounded, explicitly modeled semantic fields here.
  }),
  tree: {
    // amplio:plugins
  },
});
`;
}
