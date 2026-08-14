export interface ReconcileInput {
  jobId: string;
  queue: string;
}

export async function reconcileBilling(input: ReconcileInput) {
  return {
    job: input,
    recordsProcessed: 1,
  };
}
