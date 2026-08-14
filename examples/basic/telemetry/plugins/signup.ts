import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import { z } from "zod";
import { signUp as signUpNative } from "../../src/signup.js";

const SignedUp = event({
  id: "auth.user.signed_up",
  version: 1,
  schema: z.object({
    user: z.object({ id: z.string() }),
    method: z.enum(["email", "oauth", "invite"]),
  }),
  timing: "duration",
});

export const SignUpPlugin = plugin({
  id: "sign-up",
  events: { signed_up: SignedUp },
  instrument({ events, observe }) {
    return function instrumentSignUp<Fn extends typeof signUpNative>(
      fn: Fn,
    ): Fn {
      return observe(events.signed_up, fn, {
        input: ({ args: [input] }) => ({
          user: { id: input.id },
          method: input.method,
        }),
      });
    };
  },
});

export const signUp = SignUpPlugin(signUpNative);
