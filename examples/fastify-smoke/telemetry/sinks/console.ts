import type { Sink } from "@useamplio/amplio";

const createJsonReplacer = () => {
  const ancestors: object[] = [];
  return function (this: object, _key: string, value: unknown): unknown {
    if (typeof value === "bigint") return value.toString();
    if (value === null || typeof value !== "object") return value;
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) {
      ancestors.pop();
    }
    if (ancestors.includes(value)) return "[Circular]";
    ancestors.push(value);
    return value;
  };
};

export const consoleSink: Sink = (record) => {
  console.log(JSON.stringify(record, createJsonReplacer()));
};
