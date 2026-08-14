type ResourceAttributes = Readonly<Record<string, string | number | boolean>>;
type ResourceEnricher = (
  current: ResourceAttributes,
) => ResourceAttributes | undefined;

function envOrUndefined(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/** Adds bounded operational attributes under `record.resource`. */
export const serviceMetadata: ResourceEnricher = (
  current: ResourceAttributes,
) => ({
  ...current,
  ...(envOrUndefined("AMPLIO_SERVICE")
    ? { "deployment.name": envOrUndefined("AMPLIO_SERVICE")! }
    : {}),
  ...(envOrUndefined("AMPLIO_SERVICE_VERSION")
    ? { "deployment.version": envOrUndefined("AMPLIO_SERVICE_VERSION")! }
    : {}),
  ...(envOrUndefined("AMPLIO_REGION")
    ? { "deployment.region": envOrUndefined("AMPLIO_REGION")! }
    : {}),
});
