import type {
  EventShape,
  SyncStandardSchemaPathSegment,
  SyncStandardSchemaV1,
  ZodLikeSchema,
} from "./types.js";
import {
  AmplioValidationError,
  issuesFromUnknown,
} from "./validation-error.js";

const isStandardSchema = <T extends Record<string, unknown>>(
  shape: EventShape<T>,
): shape is SyncStandardSchemaV1<T> =>
  shape !== undefined &&
  typeof shape === "object" &&
  "~standard" in shape &&
  typeof (shape as SyncStandardSchemaV1<T>)["~standard"]?.validate ===
    "function";

const isZodLike = <T extends Record<string, unknown>>(
  shape: EventShape<T>,
): shape is ZodLikeSchema<T> =>
  shape !== undefined &&
  typeof (shape as ZodLikeSchema<T>).safeParse === "function";

const pathKey = (part: SyncStandardSchemaPathSegment): PropertyKey =>
  typeof part === "object" && part !== null && "key" in part ? part.key : part;

export function validateShape<T extends Record<string, unknown>>(
  shape: EventShape<T> | undefined,
  value: Record<string, unknown>,
): T {
  if (shape === undefined) {
    return value as T;
  }

  if (isStandardSchema(shape)) {
    const result = shape["~standard"].validate(value);
    if (
      result !== null &&
      typeof result === "object" &&
      "then" in result &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      void Promise.resolve(result).catch(() => undefined);
      throw new AmplioValidationError([
        {
          message:
            "Async Standard Schema validation is unsupported; use a synchronous schema",
          path: [],
        },
      ]);
    }
    if (result.issues?.length) {
      throw new AmplioValidationError(
        result.issues.map((issue) => ({
          message: issue.message,
          path: issue.path ? issue.path.map(pathKey) : [],
        })),
      );
    }
    return (result.value ?? value) as T;
  }

  if (isZodLike(shape)) {
    const result = shape.safeParse(value);
    if (!result.success) {
      throw new AmplioValidationError(issuesFromUnknown(result.error));
    }
    return result.data;
  }

  return value as T;
}
