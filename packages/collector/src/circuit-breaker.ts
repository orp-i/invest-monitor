export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private stateValue: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAtMs = 0;
  private probeInFlight = false;

  public constructor(
    private readonly failureThreshold = 5,
    private readonly cooldownMs = 30_000,
  ) {}

  public get state(): CircuitState {
    if (this.stateValue === "open" && Date.now() - this.openedAtMs >= this.cooldownMs) {
      this.stateValue = "half-open";
      this.probeInFlight = false;
    }
    return this.stateValue;
  }

  public allowRequest(): boolean {
    const state = this.state;
    if (state === "closed") return true;
    if (state === "open") return false;
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  public recordSuccess(): void {
    this.stateValue = "closed";
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  public recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.stateValue = "open";
      this.openedAtMs = Date.now();
    }
  }
}
