export interface AmplioValidationIssue {
  message: string;
  path: PropertyKey[];
}

export class AmplioValidationError extends Error {
  readonly issues: AmplioValidationIssue[];

  constructor(issues: AmplioValidationIssue[]) {
    const detail =
      issues.length === 0
        ? "Event validation failed"
        : issues
            .map((issue) =>
              issue.path.length > 0
                ? `${issue.path.join(".")}: ${issue.message}`
                : issue.message,
            )
            .join("; ");
    super(`Event validation failed: ${detail}`);
    this.name = "AmplioValidationError";
    this.issues = issues;
  }
}

export function issuesFromUnknown(error: unknown): AmplioValidationIssue[] {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return (error as { issues: Array<{ message?: unknown; path?: unknown }> }).issues.map(
      (issue) => ({
        message: typeof issue.message === "string" ? issue.message : "Invalid value",
        path: Array.isArray(issue.path) ? (issue.path as PropertyKey[]) : [],
      }),
    );
  }

  if (error instanceof Error && error.message) {
    return [{ message: error.message, path: [] }];
  }

  return [{ message: "Invalid value", path: [] }];
}
