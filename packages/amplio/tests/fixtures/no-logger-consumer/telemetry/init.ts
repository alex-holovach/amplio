import { init, type Sink } from "@useamplio/amplio";

export function configureTelemetry(sinks: Sink[]): void {
  init({
    service: "orders-api",
    env: "test",
    sinks,
  });
}
