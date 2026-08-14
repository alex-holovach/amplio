export interface AuthCheck {
  method: string;
}

/** Ordinary domain seam: it knows nothing about telemetry or Express. */
export async function authenticate(): Promise<AuthCheck> {
  await new Promise((resolve) => setTimeout(resolve, 35));
  return { method: "demo" };
}
