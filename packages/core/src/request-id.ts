export function createRequestId(): string {
  const time = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `req_${time}_${rand}`;
}
