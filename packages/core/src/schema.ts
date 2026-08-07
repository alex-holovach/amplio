import type { EventShape, StandardSchemaV1, ZodLikeSchema } from "./types.js";
import { LogcnValidationError, issuesFromUnknown } from "./validation-error.js";

const isStandardSchema = <T extends Record<string, unknown>>(
  shape: EventShape<T>,
): shape is StandardSchemaV1<T> =>
  shape !== undefined &&
  typeof shape === "object" &&
  "~standard" in shape &&
  typeof (shape as StandardSchemaV1<T>)["~standard"]?.validate === "function";

const isZodLike = <T extends Record<string, unknown>>(
  shape: EventShape<T>,
): shape is ZodLikeSchema<T> =>
  shape !== undefined && typeof (shape as ZodLikeSchema<T>).safeParse === "function";

export function validateShape<T extends Record<string, unknown>>(
  shape: EventShape<T> | undefined,
  value: Record<string, unknown>,
): T {
  if (shape === undefined) {
    return value as T;
  }

  if (isStandardSchema(shape)) {
    const result = shape["~standard"].validate(value);
    if (result.issues?.length) {
      throw new LogcnValidationError(
        result.issues.map((issue) => ({
          message: issue.message,
          path: issue.path ? [...issue.path] : [],
        })),
      );
    }
    return (result.value ?? value) as T;
  }

  if (isZodLike(shape)) {
    const result = shape.safeParse(value);
    if (!result.success) {
      throw new LogcnValidationError(issuesFromUnknown(result.error));
    }
    return result.data;
  }

  return value as T;
}
