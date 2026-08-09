import type { StructuredError } from "./types.js";

export function createError(input: StructuredError): StructuredError {
  return {
    message: input.message,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.why !== undefined ? { why: input.why } : {}),
    ...(input.fix !== undefined ? { fix: input.fix } : {}),
    ...(input.code !== undefined ? { code: input.code } : {}),
    ...(input.link !== undefined ? { link: input.link } : {}),
  };
}
