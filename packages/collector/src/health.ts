import { Decimal } from "decimal.js";
import { DEFAULT_CLOCK_SKEW_TOLERANCE_MS, type SourceError } from "@invest/domain";
import type { SourceHealthInput } from "@invest/storage";
import { CircuitBreaker, type CircuitState } from "./circuit-breaker.js";

interface HealthState {
  total: number;
  successes: number;
  latencies: number[];
  lastSuccessAt: string | null;
  lastError: SourceError | null;
  status: "healthy" | "degraded" | "down";
  egressProfileUsed: SourceHealthInput["egressProfileUsed"];
  circuit: CircuitBreaker;
}

export class HealthTracker {
  private readonly states = new Map<string, HealthState>();
  private readonly clockSkewsBySource = new Map<string, number[]>();
  private clockSkewToleranceMs: number;

  public constructor(clockSkewToleranceMs = DEFAULT_CLOCK_SKEW_TOLERANCE_MS) {
    this.clockSkewToleranceMs = clockSkewToleranceMs;
  }

  public setClockSkewToleranceMs(clockSkewToleranceMs: number): void {
    this.clockSkewToleranceMs = clockSkewToleranceMs;
  }

  public recordSuccess(
    sourceId: string,
    capability: string,
    latencyMs: number,
    clockSkewMs: number | null = null,
    egressProfileUsed: SourceHealthInput["egressProfileUsed"] = null,
  ): SourceHealthInput {
    const state = this.state(sourceId, capability);
    state.total += 1;
    state.successes += 1;
    state.latencies.push(latencyMs);
    if (state.latencies.length > 100) state.latencies.shift();
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    state.status = "healthy";
    state.egressProfileUsed = egressProfileUsed;
    state.circuit.recordSuccess();
    this.recordClockSkew(sourceId, clockSkewMs);
    return this.toInput(sourceId, capability, state);
  }

  public recordFailure(
    sourceId: string,
    capability: string,
    error: SourceError,
    clockSkewMs?: number | null,
    egressProfileUsed: SourceHealthInput["egressProfileUsed"] = error.egressProfileUsed,
  ): SourceHealthInput {
    const state = this.state(sourceId, capability);
    state.total += 1;
    state.lastError = error;
    state.circuit.recordFailure();
    state.status = state.circuit.state === "open" ? "down" : "degraded";
    state.egressProfileUsed = egressProfileUsed;
    this.recordClockSkew(sourceId, clockSkewMs ?? error.clockSkewMs);
    return this.toInput(sourceId, capability, state);
  }

  public snapshot(sourceId?: string, capability?: string): SourceHealthInput[] {
    const entries: SourceHealthInput[] = [];
    for (const [key, state] of this.states) {
      const [entrySource, entryCapability] = key.split("\u0000");
      if (sourceId && sourceId !== entrySource) continue;
      if (capability && capability !== entryCapability) continue;
      entries.push(this.toInput(entrySource, entryCapability, state));
    }
    return entries;
  }

  public circuitState(sourceId: string, capability: string): CircuitState {
    return this.state(sourceId, capability).circuit.state;
  }

  private state(sourceId: string, capability: string): HealthState {
    const key = `${sourceId}\u0000${capability}`;
    const current = this.states.get(key);
    if (current) return current;
    const created: HealthState = {
      total: 0,
      successes: 0,
      latencies: [],
      lastSuccessAt: null,
      lastError: null,
      status: "degraded",
      egressProfileUsed: null,
      circuit: new CircuitBreaker(),
    };
    this.states.set(key, created);
    return created;
  }

  private toInput(sourceId: string, capability: string, state: HealthState): SourceHealthInput {
    const successRate = state.total === 0 ? "0" : new Decimal(state.successes).div(state.total).toFixed(6);
    const clockSkewMedianMs = median(this.clockSkewsBySource.get(sourceId) ?? []);
    return {
      sourceId,
      capability,
      observedAt: new Date().toISOString(),
      status: state.status,
      successRate,
      p50LatencyMs: percentile(state.latencies, 0.5),
      p95LatencyMs: percentile(state.latencies, 0.95),
      quotaUsed: null,
      circuitState: state.circuit.state,
      lastSuccessAt: state.lastSuccessAt,
      lastError: state.lastError,
      clockSkewMedianMs,
      clockSkewStatus: clockSkewMedianMs === null
        ? "unknown"
        : Math.abs(clockSkewMedianMs) > this.clockSkewToleranceMs ? "suspected" : "normal",
      clockSkewToleranceMs: this.clockSkewToleranceMs,
      egressProfileUsed: state.egressProfileUsed,
    };
  }

  private recordClockSkew(sourceId: string, clockSkewMs: number | null | undefined): void {
    if (clockSkewMs === null || clockSkewMs === undefined || !Number.isFinite(clockSkewMs)) return;
    const values = this.clockSkewsBySource.get(sourceId) ?? [];
    values.push(clockSkewMs);
    if (values.length > 100) values.shift();
    this.clockSkewsBySource.set(sourceId, values);
  }
}

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? null;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle];
  return Number.isFinite(value) ? Math.round(value) : null;
}
