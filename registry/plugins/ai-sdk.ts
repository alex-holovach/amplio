import { event } from "@useamplio/amplio";
import { plugin } from "@useamplio/amplio/plugin";
import type { streamText, Telemetry } from "ai";
import { z } from "zod";

const Operation = z.enum([
  "generate_text",
  "stream_text",
  "generate_object",
  "stream_object",
  "embed",
  "embed_many",
  "rerank",
  "other",
]);

const FinishReason = z.enum([
  "stop",
  "length",
  "content_filter",
  "tool_calls",
  "error",
  "other",
]);

const ReasoningEffort = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

const Provider = z.enum([
  "openai",
  "anthropic",
  "google",
  "azure_openai",
  "amazon_bedrock",
  "vertex",
  "mistral",
  "cohere",
  "xai",
  "groq",
  "deepseek",
  "perplexity",
  "together",
  "fireworks",
  "cerebras",
  "replicate",
  "huggingface",
  "gateway",
  "other",
]);

const ModelFamily = z.enum([
  "gpt-5",
  "gpt-4.1",
  "gpt-4o",
  "o-series",
  "claude-opus",
  "claude-sonnet",
  "claude-haiku",
  "gemini",
  "llama",
  "mistral",
  "command",
  "grok",
  "deepseek",
  "qwen",
  "embedding",
  "rerank",
  "other",
]);

const OutputKind = z.enum([
  "text",
  "object",
  "array",
  "enum",
  "choice",
  "json",
  "no_schema",
  "other",
]);

const MAX_TOKEN_COUNT = 1_000_000_000;
const MAX_AGGREGATE_COUNT = 1_000_000;
const MAX_RETRIES = 100;
const MAX_DURATION_MS = 31_536_000_000;
const MAX_SCAN_ITEMS = 1_024;

const AiOperation = event({
  id: "ai.operation",
  version: 2,
  schema: z.object({
    operation: Operation,
    provider: Provider.optional(),
    model_family: ModelFamily.optional(),
    max_retries: z.number().int().nonnegative().max(MAX_RETRIES).optional(),
    max_output_tokens: z
      .number()
      .int()
      .positive()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    top_p: z.number().finite().min(0).max(1).optional(),
    top_k: z.number().finite().nonnegative().max(1_000_000).optional(),
    presence_penalty: z.number().finite().min(-2).max(2).optional(),
    frequency_penalty: z.number().finite().min(-2).max(2).optional(),
    seeded: z.boolean().optional(),
    reasoning_effort: ReasoningEffort.optional(),
    stop_sequence_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    output_kind: OutputKind.optional(),
    tool_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    timeout_ms: z.number().int().nonnegative().max(MAX_DURATION_MS).optional(),
    step_timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
    chunk_timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
    tool_timeout_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
    finish_reason: FinishReason.optional(),
    input_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    output_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    total_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    cached_input_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    cache_write_input_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    text_tokens: z.number().int().nonnegative().max(MAX_TOKEN_COUNT).optional(),
    reasoning_tokens: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_TOKEN_COUNT)
      .optional(),
    step_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    tool_call_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    tool_result_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    warning_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    model_call_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    content_part_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    file_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    source_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    response_message_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    item_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    result_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    requested_result_count: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_AGGREGATE_COUNT)
      .optional(),
    provider_response_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
    step_time_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
    tool_execution_ms: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DURATION_MS)
      .optional(),
  }),
  timing: "duration",
  cardinality: { many: { max: 32 } },
  maxDurationMs: 5 * 60_000,
});

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object"
    ? (value as JsonRecord)
    : undefined;
}

function property(value: unknown, key: string): unknown {
  try {
    return record(value)?.[key];
  } catch {
    return undefined;
  }
}

function callId(value: unknown): string | undefined {
  const candidate = property(value, "callId");
  return typeof candidate === "string" && candidate.length <= 128
    ? candidate
    : undefined;
}

function count(value: unknown, max = MAX_TOKEN_COUNT): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
    ? value
    : undefined;
}

function arrayLength(value: unknown): number | undefined {
  try {
    return Array.isArray(value)
      ? count(value.length, MAX_AGGREGATE_COUNT)
      : undefined;
  } catch {
    return undefined;
  }
}

function isArray(value: unknown): boolean | undefined {
  try {
    return Array.isArray(value);
  } catch {
    return undefined;
  }
}

function boundedDecimal(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    return undefined;
  }
  return Math.round(value * 100) / 100;
}

const TIMEOUT_BUCKETS_MS = [
  100,
  250,
  500,
  1_000,
  2_000,
  3_000,
  4_000,
  5_000,
  8_000,
  10_000,
  15_000,
  30_000,
  60_000,
  120_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
  21_600_000,
  86_400_000,
  604_800_000,
  2_592_000_000,
  MAX_DURATION_MS,
] as const;

const OUTPUT_TOKEN_BUCKETS = [
  64,
  128,
  256,
  512,
  1_024,
  2_048,
  4_096,
  8_192,
  16_384,
  32_768,
  65_536,
  131_072,
  262_144,
  524_288,
  1_000_000,
  10_000_000,
  100_000_000,
  MAX_TOKEN_COUNT,
] as const;

const TOP_K_BUCKETS = [
  1,
  2,
  4,
  8,
  16,
  32,
  40,
  50,
  64,
  100,
  128,
  256,
  512,
  1_024,
  4_096,
  16_384,
  65_536,
  MAX_AGGREGATE_COUNT,
] as const;

function positiveIntegerBucket(
  value: unknown,
  boundaries: readonly number[],
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return undefined;
  }
  return boundaries.find((boundary) => value <= boundary);
}

function timeoutBucketMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  if (value === 0) return 0;
  return TIMEOUT_BUCKETS_MS.find((boundary) => value <= boundary);
}

function measuredDurationMs(value: unknown): number | undefined {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_DURATION_MS
  ) {
    return undefined;
  }
  return Math.round(value);
}

function sumDuration(total: number, value: unknown): number | undefined {
  const candidate = measuredDurationMs(value);
  if (candidate === undefined || total + candidate > MAX_DURATION_MS) {
    return undefined;
  }
  return total + candidate;
}

function provider(value: unknown): z.infer<typeof Provider> | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  const category = normalized.split(/[.:/]/u, 1)[0]?.replace(/_/gu, "-");
  if (category === "azure" || category === "azure-openai") {
    return "azure_openai";
  }
  if (category === "bedrock" || category === "amazon-bedrock") {
    return "amazon_bedrock";
  }
  if (category === "vertex" || category === "vertex-ai") return "vertex";
  if (category === "anthropic") return "anthropic";
  if (category === "openai") return "openai";
  if (category === "google") return "google";
  if (category === "mistral") return "mistral";
  if (category === "cohere") return "cohere";
  if (category === "xai") return "xai";
  if (category === "groq") return "groq";
  if (category === "deepseek") return "deepseek";
  if (category === "perplexity") return "perplexity";
  if (category === "together") return "together";
  if (category === "fireworks") return "fireworks";
  if (category === "cerebras") return "cerebras";
  if (category === "replicate") return "replicate";
  if (category === "huggingface") return "huggingface";
  if (category === "gateway") return "gateway";
  return "other";
}

function modelFamily(value: unknown): z.infer<typeof ModelFamily> | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (/^gpt-5(?:$|[-.:/])/u.test(normalized)) return "gpt-5";
  if (/^gpt-4\.1(?:$|[-.:/])/u.test(normalized)) return "gpt-4.1";
  if (/^gpt-4o(?:$|[-.:/])/u.test(normalized)) return "gpt-4o";
  if (/^o[134](?:$|[-.:/])/u.test(normalized)) return "o-series";
  if (
    /^claude(?:$|[-.:/])/u.test(normalized) &&
    /(?:^|-)opus(?:-|$)/u.test(normalized)
  ) {
    return "claude-opus";
  }
  if (
    /^claude(?:$|[-.:/])/u.test(normalized) &&
    /(?:^|-)sonnet(?:-|$)/u.test(normalized)
  ) {
    return "claude-sonnet";
  }
  if (
    /^claude(?:$|[-.:/])/u.test(normalized) &&
    /(?:^|-)haiku(?:-|$)/u.test(normalized)
  ) {
    return "claude-haiku";
  }
  if (/^gemini(?:$|[-.:/])/u.test(normalized)) return "gemini";
  if (/^llama(?:$|[-.:/])/u.test(normalized)) return "llama";
  if (/^(?:mistral|mixtral)(?:$|[-.:/])/u.test(normalized)) {
    return "mistral";
  }
  if (/^command(?:$|[-.:/])/u.test(normalized)) return "command";
  if (/^grok(?:$|[-.:/])/u.test(normalized)) return "grok";
  if (/^deepseek(?:$|[-.:/])/u.test(normalized)) return "deepseek";
  if (/^qwen(?:$|[-.:/])/u.test(normalized)) return "qwen";
  if (/^(?:text-)?embedding(?:$|[-.:/])/u.test(normalized)) return "embedding";
  if (/^rerank(?:$|[-.:/])/u.test(normalized)) return "rerank";
  return "other";
}

function outputKind(
  value: unknown,
  currentOperation: z.infer<typeof Operation>,
): z.infer<typeof OutputKind> | undefined {
  const name = property(value, "name");
  const parsed = OutputKind.safeParse(name);
  if (parsed.success) return parsed.data;
  return currentOperation === "generate_text" ||
    currentOperation === "stream_text"
    ? "text"
    : undefined;
}

function objectKeyCount(value: unknown): number | undefined {
  const candidate = record(value);
  if (!candidate) return undefined;
  try {
    let total = 0;
    for (const key in candidate) {
      if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;
      total += 1;
      if (total > MAX_SCAN_ITEMS) return undefined;
    }
    return total;
  } catch {
    return undefined;
  }
}

function reasoningEffort(
  value: unknown,
): z.infer<typeof ReasoningEffort> | undefined {
  const parsed = ReasoningEffort.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function operation(value: unknown): z.infer<typeof Operation> {
  switch (value) {
    case "ai.generateText":
      return "generate_text";
    case "ai.generateObject":
      return "generate_object";
    case "ai.embed":
      return "embed";
    case "ai.embedMany":
      return "embed_many";
    case "ai.rerank":
      return "rerank";
    case "ai.streamText":
    case "ai.streamObject":
      return "other";
    default:
      return "other";
  }
}

function finishReason(
  value: unknown,
): z.infer<typeof FinishReason> | undefined {
  const unified =
    typeof value === "string" ? value : property(value, "unified");
  switch (unified) {
    case "stop":
    case "length":
    case "error":
    case "other":
      return unified;
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_calls";
    default:
      return undefined;
  }
}

function optionalCount(
  key: string,
  value: unknown,
  max = MAX_TOKEN_COUNT,
): JsonRecord {
  const candidate = count(value, max);
  return candidate === undefined ? {} : { [key]: candidate };
}

function optionalIntegerBucket(
  key: string,
  value: unknown,
  boundaries: readonly number[],
): JsonRecord {
  const candidate = positiveIntegerBucket(value, boundaries);
  return candidate === undefined ? {} : { [key]: candidate };
}

function optionalDecimal(
  key: string,
  value: unknown,
  minimum: number,
  maximum: number,
): JsonRecord {
  const candidate = boundedDecimal(value, minimum, maximum);
  return candidate === undefined ? {} : { [key]: candidate };
}

function optionalTimeout(key: string, value: unknown): JsonRecord {
  const candidate = timeoutBucketMs(value);
  return candidate === undefined ? {} : { [key]: candidate };
}

function performanceTotals(steps: unknown): {
  providerResponseMs?: number;
  stepTimeMs?: number;
  toolExecutionMs?: number;
} {
  let length: number;
  try {
    if (!Array.isArray(steps)) return {};
    length = steps.length;
  } catch {
    return {};
  }
  if (length > MAX_SCAN_ITEMS) return {};

  let providerResponseMs = 0;
  let stepTimeMs = 0;
  let toolExecutionMs = 0;
  let hasProviderResponse = false;
  let hasStepTime = false;
  let hasToolExecution = false;
  let scannedToolTimings = 0;

  for (let index = 0; index < length; index += 1) {
    const performance = property(property(steps, String(index)), "performance");
    const response = measuredDurationMs(
      property(performance, "responseTimeMs"),
    );
    if (response !== undefined) {
      const next = sumDuration(providerResponseMs, response);
      if (next === undefined) return {};
      providerResponseMs = next;
      hasProviderResponse = true;
    }
    const step = measuredDurationMs(property(performance, "stepTimeMs"));
    if (step !== undefined) {
      const next = sumDuration(stepTimeMs, step);
      if (next === undefined) return {};
      stepTimeMs = next;
      hasStepTime = true;
    }
    const timings = record(property(performance, "toolExecutionMs"));
    if (!timings) continue;
    try {
      for (const key in timings) {
        if (!Object.prototype.hasOwnProperty.call(timings, key)) continue;
        scannedToolTimings += 1;
        if (scannedToolTimings > MAX_SCAN_ITEMS) return {};
        const next = sumDuration(toolExecutionMs, property(timings, key));
        if (next === undefined) return {};
        toolExecutionMs = next;
        hasToolExecution = true;
      }
    } catch {
      return {};
    }
  }

  return {
    ...(hasProviderResponse ? { providerResponseMs } : {}),
    ...(hasStepTime ? { stepTimeMs } : {}),
    ...(hasToolExecution || length > 0 ? { toolExecutionMs } : {}),
  };
}

function endProjection(value: unknown): JsonRecord {
  const usage = property(value, "usage");
  const inputTokens =
    count(property(usage, "inputTokens")) ?? count(property(usage, "tokens"));
  const outputTokens = count(property(usage, "outputTokens"));
  const totalTokens = count(property(usage, "totalTokens"));
  const inputTokenDetails = property(usage, "inputTokenDetails");
  const outputTokenDetails = property(usage, "outputTokenDetails");
  const steps = property(value, "steps");
  const toolCalls = property(value, "toolCalls");
  const embedding = property(value, "embedding");
  const ranking = property(value, "ranking");
  const reason = finishReason(property(value, "finishReason"));
  const { providerResponseMs, stepTimeMs, toolExecutionMs } =
    performanceTotals(steps);
  const warningCount = arrayLength(property(value, "warnings"));
  const toolResultCount = arrayLength(property(value, "toolResults"));
  const contentPartCount = arrayLength(property(value, "content"));
  const fileCount = arrayLength(property(value, "files"));
  const sourceCount = arrayLength(property(value, "sources"));
  const responseMessageCount = arrayLength(property(value, "responseMessages"));
  const modelCallCount = arrayLength(steps);
  const embeddingLength = arrayLength(embedding);
  const firstEmbeddingIsArray =
    embeddingLength === undefined || embeddingLength === 0
      ? undefined
      : isArray(property(embedding, "0"));

  return {
    ...(reason ? { finish_reason: reason } : {}),
    ...optionalCount("input_tokens", inputTokens),
    ...optionalCount("output_tokens", outputTokens),
    ...optionalCount(
      "total_tokens",
      totalTokens ??
        (inputTokens !== undefined && outputTokens !== undefined
          ? count(inputTokens + outputTokens)
          : undefined),
    ),
    ...optionalCount(
      "cached_input_tokens",
      property(inputTokenDetails, "cacheReadTokens"),
    ),
    ...optionalCount(
      "cache_write_input_tokens",
      property(inputTokenDetails, "cacheWriteTokens"),
    ),
    ...optionalCount("text_tokens", property(outputTokenDetails, "textTokens")),
    ...optionalCount(
      "reasoning_tokens",
      property(outputTokenDetails, "reasoningTokens"),
    ),
    ...(modelCallCount === undefined
      ? {}
      : { model_call_count: modelCallCount }),
    ...(modelCallCount === undefined ? {} : { step_count: modelCallCount }),
    ...(arrayLength(toolCalls) === undefined
      ? {}
      : { tool_call_count: arrayLength(toolCalls) }),
    ...(toolResultCount === undefined
      ? {}
      : { tool_result_count: toolResultCount }),
    ...(warningCount === undefined ? {} : { warning_count: warningCount }),
    ...(contentPartCount === undefined
      ? {}
      : { content_part_count: contentPartCount }),
    ...(fileCount === undefined ? {} : { file_count: fileCount }),
    ...(sourceCount === undefined ? {} : { source_count: sourceCount }),
    ...(responseMessageCount === undefined
      ? {}
      : { response_message_count: responseMessageCount }),
    ...(providerResponseMs === undefined
      ? {}
      : { provider_response_ms: providerResponseMs }),
    ...(stepTimeMs === undefined ? {} : { step_time_ms: stepTimeMs }),
    ...(toolExecutionMs === undefined
      ? {}
      : { tool_execution_ms: toolExecutionMs }),
    ...(embeddingLength === undefined
      ? {}
      : embeddingLength === 0
        ? { result_count: 0 }
        : firstEmbeddingIsArray === true
          ? { result_count: embeddingLength }
          : firstEmbeddingIsArray === false
            ? { result_count: 1 }
            : {}),
    ...(arrayLength(ranking) === undefined
      ? {}
      : { result_count: arrayLength(ranking) }),
  };
}

export const AiSdkPlugin = plugin({
  id: "ai-sdk",
  events: { operations: AiOperation },
  instrument({ events, begin }) {
    const start = (
      value: unknown,
      currentOperation: z.infer<typeof Operation>,
    ) => {
      const inputValue = property(value, "value");
      const documents = property(value, "documents");
      const model = property(value, "model");
      const output = property(value, "output");
      const tools = property(value, "tools");
      const timeout = property(value, "timeout");
      const timeoutOptions = record(timeout);
      const effort = reasoningEffort(property(value, "reasoning"));
      const stopSequences = property(value, "stopSequences");
      const currentProvider = provider(
        property(value, "provider") ?? property(model, "provider"),
      );
      const currentModelFamily = modelFamily(
        property(value, "modelId") ?? property(model, "modelId"),
      );
      const currentOutputKind = outputKind(output, currentOperation);
      const currentToolCount =
        objectKeyCount(tools) ?? (tools === undefined ? 0 : undefined);
      const stopSequenceCount = arrayLength(stopSequences);
      const itemCount =
        currentOperation === "embed"
          ? 1
          : currentOperation === "embed_many"
            ? arrayLength(inputValue)
            : currentOperation === "rerank"
              ? arrayLength(documents)
              : undefined;
      return begin(
        events.operations,
        {
          operation: currentOperation,
          ...(currentProvider ? { provider: currentProvider } : {}),
          ...(currentModelFamily ? { model_family: currentModelFamily } : {}),
          ...optionalCount(
            "max_retries",
            property(value, "maxRetries"),
            MAX_RETRIES,
          ),
          ...optionalIntegerBucket(
            "max_output_tokens",
            property(value, "maxOutputTokens"),
            OUTPUT_TOKEN_BUCKETS,
          ),
          ...optionalDecimal(
            "temperature",
            property(value, "temperature"),
            0,
            2,
          ),
          ...optionalDecimal("top_p", property(value, "topP"), 0, 1),
          ...optionalIntegerBucket(
            "top_k",
            property(value, "topK"),
            TOP_K_BUCKETS,
          ),
          ...optionalDecimal(
            "presence_penalty",
            property(value, "presencePenalty"),
            -2,
            2,
          ),
          ...optionalDecimal(
            "frequency_penalty",
            property(value, "frequencyPenalty"),
            -2,
            2,
          ),
          ...(typeof property(value, "seed") === "number" &&
          Number.isSafeInteger(property(value, "seed"))
            ? { seeded: true }
            : {}),
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(stopSequenceCount === undefined
            ? {}
            : { stop_sequence_count: stopSequenceCount }),
          ...(currentOutputKind ? { output_kind: currentOutputKind } : {}),
          ...(currentToolCount === undefined
            ? {}
            : { tool_count: currentToolCount }),
          ...optionalTimeout(
            "timeout_ms",
            typeof timeout === "number"
              ? timeout
              : property(timeoutOptions, "totalMs"),
          ),
          ...optionalTimeout(
            "step_timeout_ms",
            property(timeoutOptions, "stepMs"),
          ),
          ...optionalTimeout(
            "chunk_timeout_ms",
            property(timeoutOptions, "chunkMs"),
          ),
          ...optionalTimeout(
            "tool_timeout_ms",
            property(timeoutOptions, "toolMs"),
          ),
          ...(itemCount === undefined ? {} : { item_count: itemCount }),
          ...optionalCount(
            "requested_result_count",
            property(value, "topN"),
            MAX_AGGREGATE_COUNT,
          ),
        },
        { retainParent: true },
      );
    };
    type Handle = ReturnType<typeof start>;
    const active = new Map<
      string,
      { handle: Handle; timeout: ReturnType<typeof setTimeout> }
    >();

    const take = (value: unknown): Handle | undefined => {
      const id = callId(value);
      if (!id) return;
      const entry = active.get(id);
      if (!entry) return;
      active.delete(id);
      clearTimeout(entry.timeout);
      return entry.handle;
    };

    const integration: Telemetry = {
      onStart(value) {
        const id = callId(value);
        if (!id) return;
        const currentOperation = operation(property(value, "operationId"));
        if (currentOperation === "other") return;
        const previous = active.get(id);
        if (previous) return;
        while (!active.has(id) && active.size >= 1_024) {
          const oldestId = active.keys().next().value as string | undefined;
          if (!oldestId) break;
          const oldest = active.get(oldestId);
          active.delete(oldestId);
          if (oldest) {
            clearTimeout(oldest.timeout);
            oldest.handle.cancel("ai_overflow");
          }
        }
        const handle = start(value, currentOperation);
        const timeout = setTimeout(() => {
          active.delete(id);
          handle.cancel("ai_timeout");
        }, 5 * 60_000);
        timeout.unref?.();
        active.set(id, { handle, timeout });
      },
      onEnd(value) {
        const handle = take(value);
        if (!handle) return;
        const projected = endProjection(value);
        handle.end(projected, {
          success: projected.finish_reason !== "error",
        });
      },
      onAbort(value) {
        take(value)?.cancel("ai_aborted");
      },
      onError(value) {
        take(value)?.fail(property(value, "error"));
      },
    };

    type StreamTextFunction = typeof streamText;
    type Instrumenter = (() => Telemetry) & {
      streamText<F extends StreamTextFunction>(implementation: F): F;
    };
    const streamTextWrappers = new WeakMap<
      StreamTextFunction,
      StreamTextFunction
    >();
    const createAiSdkTelemetry = (() => integration) as Instrumenter;
    createAiSdkTelemetry.streamText = <F extends StreamTextFunction>(
      implementation: F,
    ): F => {
      const existingWrapper = streamTextWrappers.get(implementation);
      if (existingWrapper) return existingWrapper as F;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const supplied = record(args[0]);
        if (!supplied) {
          return Reflect.apply(
            implementation as (...values: unknown[]) => unknown,
            this,
            args,
          );
        }
        const telemetry =
          record(property(supplied, "telemetry")) ??
          record(property(supplied, "experimental_telemetry"));
        const configuredIntegrations = property(telemetry, "integrations");
        const selectedIntegrations =
          configuredIntegrations === undefined
            ? undefined
            : Array.isArray(configuredIntegrations)
              ? configuredIntegrations
              : [configuredIntegrations];
        if (
          property(telemetry, "isEnabled") === false ||
          (selectedIntegrations !== undefined &&
            !selectedIntegrations.includes(integration))
        ) {
          return Reflect.apply(
            implementation as (...values: unknown[]) => unknown,
            this,
            args,
          );
        }
        const handle = start(supplied, "stream_text");
        const existingEnd =
          typeof supplied.onEnd === "function"
            ? supplied.onEnd
            : typeof supplied.onFinish === "function"
              ? supplied.onFinish
              : undefined;
        const existingAbort =
          typeof supplied.onAbort === "function" ? supplied.onAbort : undefined;
        const existingError =
          typeof supplied.onError === "function" ? supplied.onError : undefined;
        const invoke = (callback: unknown, value: unknown): unknown =>
          Reflect.apply(
            callback as (...values: unknown[]) => unknown,
            undefined,
            [value],
          );
        const options = {
          ...supplied,
          onEnd: async (value: unknown) => {
            try {
              const result = existingEnd
                ? await invoke(existingEnd, value)
                : undefined;
              const projected = endProjection(value);
              handle.end(projected, {
                success: projected.finish_reason !== "error",
              });
              return result;
            } catch (error) {
              handle.fail(error);
              throw error;
            }
          },
          onAbort: async (value: unknown) => {
            try {
              const result = existingAbort
                ? await invoke(existingAbort, value)
                : undefined;
              handle.cancel("ai_aborted");
              return result;
            } catch (error) {
              handle.fail(error);
              throw error;
            }
          },
          onError: async (value: unknown) => {
            try {
              const result = existingError
                ? await invoke(existingError, value)
                : console.error(property(value, "error"));
              handle.fail(property(value, "error"));
              return result;
            } catch (error) {
              handle.fail(error);
              throw error;
            }
          },
        };
        try {
          return Reflect.apply(
            implementation as (...values: unknown[]) => unknown,
            this,
            [options, ...args.slice(1)],
          );
        } catch (error) {
          handle.fail(error);
          throw error;
        }
      };
      const typedWrapper = wrapped as F;
      streamTextWrappers.set(implementation, typedWrapper);
      streamTextWrappers.set(typedWrapper, typedWrapper);
      return typedWrapper;
    };
    return createAiSdkTelemetry;
  },
});
