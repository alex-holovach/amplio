import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";
import { authenticate as authenticateNative } from "../../src/auth.js";

const AuthCheck = event({
  id: "auth.check",
  version: 1,
  schema: z.object({ method: z.string() }),
  timing: "duration",
});

export const AuthPlugin = plugin({
  id: "auth",
  events: { check: AuthCheck },
  instrument({ events, observe }) {
    return function instrumentAuth(
      fn: typeof authenticateNative,
    ): typeof authenticateNative {
      return observe(events.check, fn, {
        result: ({ result }) => ({ method: result.method }),
      });
    };
  },
});

export const authenticate = AuthPlugin(authenticateNative);
