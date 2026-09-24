import type {
  InstrumentMeta,
  InstrumentCandidate,
  InstrumentProbeEvidence,
  InstrumentSearchResponse,
  NewsItem,
  PnlSummary,
  PositionView,
  QuoteEnvelope,
  ServerEvent,
  Snapshot,
  SourceEgressStatus,
  SourceHealth,
  TransactionInput,
  TransactionRecord,
  ViewDescriptor,
} from "./types";

interface InstrumentsResponse {
  generation: number;
  instruments: InstrumentMeta[];
}

interface QuotesResponse {
  generation: number;
  quotes: QuoteEnvelope[];
}

interface HealthResponse {
  health: SourceHealth[];
  egress: SourceEgressStatus[];
}

interface NewsResponse {
  generation: number;
  news: NewsItem[];
}

interface PositionsResponse {
  positions: PositionView[];
}

interface TransactionsResponse {
  transactions: TransactionRecord[];
}

export interface SessionStatus {
  authenticated: boolean;
  usingInitialPassword?: boolean;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly endpoint: string;

  public constructor(status: number, endpoint: string, statusText: string, serverMessage?: string) {
    super(serverMessage ?? `${status} ${statusText} from ${endpoint}`);
    this.name = "ApiError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export async function getJson<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint, {
    signal,
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw await apiError(response, endpoint);
  }
  return await response.json() as T;
}

export async function writeJson<T>(endpoint: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(endpoint, {
    method,
    signal,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await apiError(response, endpoint);
  return await response.json() as T;
}

export async function searchInstruments(query: string): Promise<InstrumentSearchResponse> {
  return getJson(`/api/instruments/search?q=${encodeURIComponent(query)}`);
}

export async function probeInstruments(candidates: readonly InstrumentCandidate[]): Promise<{ probes: InstrumentProbeEvidence[] }> {
  return writeJson("/api/instruments/probe", "POST", { candidates });
}

export async function createInstrument(candidates: readonly InstrumentCandidate[]): Promise<{ generation: number; instrument: InstrumentMeta }> {
  return writeJson("/api/instruments", "POST", { candidates });
}

export async function deleteInstrument(instrumentId: string, hard = false): Promise<{ generation: number; status: string }> {
  const query = hard ? "?hard=true" : "";
  return writeJson(`/api/instruments/${encodeURIComponent(instrumentId)}${query}`, "DELETE");
}

export async function createTransaction(input: TransactionInput): Promise<{ transaction: TransactionRecord }> {
  return writeJson("/api/transactions", "POST", input);
}

export async function updateTransaction(
  transactionId: string,
  patch: Partial<TransactionInput>,
): Promise<{ transaction: TransactionRecord }> {
  return writeJson(`/api/transactions/${encodeURIComponent(transactionId)}`, "PATCH", patch);
}

export async function deleteTransaction(transactionId: string): Promise<void> {
  await writeJson(`/api/transactions/${encodeURIComponent(transactionId)}`, "DELETE");
}

export async function createSession(password: string): Promise<SessionStatus> {
  const endpoint = "/api/session";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw await apiError(response, endpoint);
  }
  return await response.json() as SessionStatus;
}

export async function sessionStatus(): Promise<SessionStatus | null> {
  const endpoint = "/api/session";
  const response = await fetch(endpoint, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    throw await apiError(response, endpoint);
  }
  return await response.json() as SessionStatus;
}

export async function sessionIsValid(): Promise<boolean> {
  return (await sessionStatus()) !== null;
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const endpoint = "/api/password";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!response.ok) {
    throw await apiError(response, endpoint);
  }
}

export async function logoutSession(): Promise<void> {
  const endpoint = "/api/session/logout";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!response.ok) {
    throw await apiError(response, endpoint);
  }
}

async function apiError(response: Response, endpoint: string): Promise<ApiError> {
  let serverMessage: string | undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string") {
      serverMessage = (body as { message: string }).message;
    }
  } catch {
    // Keep the status-based message when an error response has no JSON body.
  }
  return new ApiError(response.status, endpoint, response.statusText, serverMessage);
}

export async function loadSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  return getJson<Snapshot>("/api/snapshot", signal);
}

export function isServerEvent(value: unknown): value is ServerEvent {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ServerEvent>;
  return typeof candidate.id === "string"
    && typeof candidate.type === "string"
    && typeof candidate.generation === "number"
    && typeof candidate.occurredAt === "string"
    && typeof candidate.payload === "object"
    && candidate.payload !== null;
}
