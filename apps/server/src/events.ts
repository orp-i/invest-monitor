import type { ServerResponse } from "node:http";

export type ServerEventType =
  | "quote.updated"
  | "candle.updated"
  | "option-chain.updated"
  | "news.created"
  | "position.updated"
  | "pnl.updated"
  | "alert.fired"
  | "health.updated";

export interface ServerEvent {
  readonly id: string;
  readonly type: ServerEventType;
  readonly generation: number;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

interface Subscriber {
  readonly response: ServerResponse;
  readonly write: (event: ServerEvent) => void;
}

export class SseEventHub {
  private readonly history: ServerEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private nextId = 1;
  private latestGeneration = 1;

  public publish(
    type: ServerEventType,
    generation: number,
    payload: Record<string, unknown>,
  ): ServerEvent {
    const event: ServerEvent = {
      id: String(this.nextId++),
      type,
      generation,
      occurredAt: new Date().toISOString(),
      payload,
    };
    this.latestGeneration = generation;
    this.history.push(event);
    if (this.history.length > 250) this.history.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber.write(event);
      } catch {
        this.remove(subscriber);
      }
    }
    return event;
  }

  public connect(
    response: ServerResponse,
    lastEventId: string | null,
  ): { replay: readonly ServerEvent[]; historyGap: boolean; latestEventId: string; latestGeneration: number; close: () => void } {
    const parsedLastId = lastEventId ? Number(lastEventId) : 0;
    const oldestId = Number(this.history[0]?.id ?? this.nextId);
    const historyGap = Number.isSafeInteger(parsedLastId)
      && parsedLastId > 0
      && (this.history.length === 0 || parsedLastId < oldestId - 1);
    const replay = Number.isSafeInteger(parsedLastId) && parsedLastId > 0
      ? this.history.filter((event) => Number(event.id) > parsedLastId)
      : [];
    const subscriber: Subscriber = {
      response,
      write: (event) => writeEvent(response, event),
    };
    this.subscribers.add(subscriber);
    return {
      replay,
      historyGap,
      latestEventId: String(this.nextId - 1),
      latestGeneration: this.latestGeneration,
      close: () => this.remove(subscriber),
    };
  }

  public close(): void {
    for (const subscriber of this.subscribers) {
      subscriber.response.end();
    }
    this.subscribers.clear();
  }

  private remove(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    if (!subscriber.response.writableEnded) subscriber.response.end();
  }
}

export function writeEvent(response: ServerResponse, event: ServerEvent): void {
  if (response.writableEnded) return;
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}
