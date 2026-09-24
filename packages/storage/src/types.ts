import type {
  Candle,
  Instrument,
  NewsEnrichment,
  NewsItem,
  PositionLedgerTransaction,
  Quote,
  SourceBinding,
  TransactionPatch,
  TransactionWrite,
  ResearchEntry,
  BrokerSyncAttempt,
  BrokerOrderObservation,
  TradingCase,
  StatementImport,
  WeeklyReview,
  ResearchReview,
  BrokerSnapshot,
  PerformanceSample,
} from "@invest/domain";

export interface RawEventInput {
  readonly sourceId: string;
  readonly instrumentId: string | null;
  readonly capability: string | null;
  readonly requestId: string;
  readonly capturedAt: string | null;
  readonly receivedAt: string;
  readonly httpStatus: number | null;
  readonly contentType: string | null;
  readonly body: Uint8Array;
  readonly rawJson: string | null;
  readonly parseStatus: string;
  readonly egressProfileUsed: "direct" | "corp" | "vpn";
}

export interface SourceHealthInput {
  readonly sourceId: string;
  readonly capability: string;
  readonly observedAt: string;
  readonly status: string;
  readonly successRate: string;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly quotaUsed: string | null;
  readonly circuitState: string;
  readonly lastSuccessAt: string | null;
  readonly lastError: unknown | null;
  readonly clockSkewMedianMs: number | null;
  readonly clockSkewStatus: "unknown" | "normal" | "suspected";
  readonly clockSkewToleranceMs: number;
  readonly egressProfileUsed: "direct" | "corp" | "vpn" | null;
}

export interface StoredQuoteRow {
  readonly id: number;
  readonly instrumentId: string;
  readonly sourceId: string;
  readonly providerSymbol: string;
  readonly capturedAtMs: number;
  readonly receivedAtMs: number;
  readonly price: string | null;
  readonly bid: string | null;
  readonly ask: string | null;
  readonly mid: string | null;
  readonly dayOpen: string | null;
  readonly dayHigh: string | null;
  readonly dayLow: string | null;
  readonly previousClose: string | null;
  readonly volume: string | null;
  readonly quoteAsset: string;
  readonly convertedToJson: string | null;
  readonly quality: string;
  readonly freshnessStatus: string;
  readonly clockSkewMs: number | null;
  readonly skewSuspected: boolean;
  readonly freshnessBasis: "capturedAt" | "receivedAt";
  readonly clockSkewToleranceMs: number;
  readonly rawEventId: number | null;
}

export interface StoredCandleRow {
  readonly instrumentId: string;
  readonly sourceId: string;
  readonly timeframe: string;
  readonly openTimeMs: number;
  readonly closeTimeMs: number;
  readonly capturedAtMs: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume: string | null;
  readonly tradeCount: number | null;
  readonly session: string;
  readonly quoteAsset: string;
  readonly convertedToJson: string | null;
  readonly receivedAtMs: number;
  readonly clockSkewMs: number | null;
  readonly skewSuspected: boolean;
  readonly freshnessBasis: "capturedAt" | "receivedAt";
  readonly clockSkewToleranceMs: number;
}

export interface StoredSourceHealthRow {
  readonly sourceId: string;
  readonly capability: string;
  readonly observedAtMs: number;
  readonly status: string;
  readonly successRate: string;
  readonly p50LatencyMs: number | null;
  readonly p95LatencyMs: number | null;
  readonly quotaUsed: string | null;
  readonly circuitState: string;
  readonly lastSuccessAtMs: number | null;
  readonly lastErrorJson: string | null;
  readonly clockSkewMedianMs: number | null;
  readonly clockSkewStatus: "unknown" | "normal" | "suspected";
  readonly clockSkewToleranceMs: number;
  readonly egressProfileUsed: "direct" | "corp" | "vpn" | null;
}

export interface StoredSourceEgressUsage {
  readonly sourceId: string;
  readonly egressProfileUsed: "direct" | "corp" | "vpn";
  readonly requestCountSince: number;
  readonly latestObservedAtMs: number;
}

/** One account-settings override; secret values are stored encrypted by the server (the driver never decrypts). */
export interface StoredAppSetting {
  readonly key: string;
  readonly value: string;
  readonly encrypted: boolean;
  readonly updatedAtMs: number;
}

export interface StoredPasswordCredential {
  readonly passwordHash: string;
  readonly passwordSalt: string;
  readonly isInitial: boolean;
  readonly updatedAtMs: number;
}

export interface NewsAssociationInput {
  readonly instrumentId: string;
  readonly method: "rule" | "llm" | "manual";
  readonly confidence: string | null;
}

export interface NewsProvenanceInput {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly rawEventId: number | null;
}

export interface NewsWriteInput {
  readonly item: NewsItem;
  readonly associations: readonly NewsAssociationInput[];
  readonly provenance: NewsProvenanceInput;
}

export interface NewsWriteResult {
  readonly item: NewsItem;
  readonly inserted: boolean;
}

export interface StoredNewsProvenance {
  readonly id: number;
  readonly newsId: string;
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly rawEventId: number | null;
}

export interface LlmUsageInput {
  readonly providerId: string;
  readonly model: string;
  readonly routeId: string;
  readonly contentHash: string | null;
  readonly promptVersion: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: string | null;
  readonly latencyMs: number;
  readonly status: string;
  readonly createdAt: string;
}

export interface StoredLlmUsage extends LlmUsageInput {
  readonly id: number;
}

export interface LlmCacheEntry {
  readonly cacheKey: string;
  readonly contentHash: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly providerId: string;
  readonly model: string;
  readonly enrichment: NewsEnrichment;
  readonly createdAt: string;
}

export type InstrumentOrigin = "config" | "user";

export interface StoredInstrumentConfig extends Instrument {
  readonly sourceBindings: readonly SourceBinding[];
  readonly panelId: string;
  readonly watch: boolean;
  readonly origin: InstrumentOrigin;
  readonly shadowed: boolean;
}

export interface InstrumentReferenceCounts {
  readonly transactions: number;
  readonly nonZeroPositions: number;
}

export type UserInstrumentDeleteResult =
  | { readonly status: "deleted" | "deactivated"; readonly references: InstrumentReferenceCounts }
  | { readonly status: "not-found" | "config-owned"; readonly references: InstrumentReferenceCounts }
  | { readonly status: "referenced"; readonly references: InstrumentReferenceCounts };

export interface StoredTransaction extends PositionLedgerTransaction {
  readonly settlementAtMs: number | null;
  readonly externalId: string | null;
  readonly importHash: string;
  readonly rawRef: string | null;
}

export interface StoredPositionProjection {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly quantity: string;
  readonly averageCost: string;
  readonly costBasis: string;
  readonly markPrice: string | null;
  readonly marketValue: string | null;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string | null;
  readonly quoteAsset: string;
  readonly asOfMs: number;
  readonly freshnessStatus: "live" | "delayed" | "stale" | "unavailable";
}

export interface TransactionQuery {
  readonly instrumentId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

export interface StorageDriver {
  readonly kind: "node-sqlite" | "better-sqlite3";
  open(): Promise<void>;
  migrate(): Promise<void>;
  withTransaction<T>(work: (driver: StorageDriver) => Promise<T>): Promise<T>;
  appendQuotes(rows: readonly Quote[]): Promise<void>;
  appendCandles(rows: readonly Candle[]): Promise<void>;
  appendRawEvent(input: RawEventInput): Promise<number>;
  upsertInstrument(instrument: Instrument, updatedAtMs: number, origin?: InstrumentOrigin): Promise<void>;
  upsertSourceBinding(binding: SourceBinding, origin?: InstrumentOrigin): Promise<void>;
  syncConfigInstruments(instruments: readonly StoredInstrumentConfig[], updatedAtMs: number): Promise<void>;
  getUserInstruments(): Promise<StoredInstrumentConfig[]>;
  getInstrumentOrigin(instrumentId: string): Promise<InstrumentOrigin | null>;
  createUserInstrument(instrument: StoredInstrumentConfig, updatedAtMs: number): Promise<void>;
  updateUserInstrument(instrumentId: string, changes: {
    readonly displayName?: string;
    readonly active?: boolean;
    readonly tags?: readonly string[];
  }, updatedAtMs: number): Promise<boolean>;
  deleteUserInstrument(instrumentId: string, hard: boolean): Promise<UserInstrumentDeleteResult>;
  ensureManualAccount(): Promise<void>;
  getResearchEntries(): Promise<ResearchEntry[]>;
  getStudySeries(id: string): Promise<import("@invest/domain").StudySeries | null>;
  saveStudySeries(series: import("@invest/domain").StudySeries): Promise<void>;
  getStudyRecords(): Promise<import("@invest/domain").StudyRecord[]>;
  getMarketDailyReports(query: import("@invest/domain").MarketDailyQuery): Promise<import("@invest/domain").MarketDailyReport[]>;
  getMarketDailyReport(id: string, revision?: number): Promise<import("@invest/domain").MarketDailyReport | null>;
  getMarketDailyRevisions(id: string): Promise<import("@invest/domain").MarketDailyRevision[]>;
  getMarketDailyContext(query: import("@invest/domain").MarketDailyContextQuery): Promise<import("@invest/domain").MarketDailyReport[]>;
  saveMarketDailyReport(id: string, input: import("@invest/domain").MarketDailyWrite, expectedRevision: number): Promise<import("@invest/domain").MarketDailySaveResult>;
  createDailyInferenceRun(run: import("@invest/domain").DailyInferenceRun): Promise<boolean>;
  getDailyInferenceRun(id: string): Promise<import("@invest/domain").DailyInferenceRun | null>;
  getDailyInferenceRuns(reportId: string, limit: number): Promise<import("@invest/domain").DailyInferenceRunSummary[]>;
  finishDailyInferenceRun(run: import("@invest/domain").DailyInferenceRun, observations: import("@invest/domain").DailyObservation[]): Promise<void>;
  recoverDailyInferenceRuns(): Promise<void>;
  getDailyObservations(from: string, to: string, reportId?: string): Promise<import("@invest/domain").DailyObservation[]>;
  saveDailyObservation(observation: import("@invest/domain").DailyObservation, expectedRevision: number): Promise<boolean>;
  getDailyObservationHistory(id: string): Promise<import("@invest/domain").DailyObservation[]>;
  saveStudyRecord(record: import("@invest/domain").StudyRecord): Promise<void>;
  archiveStudyRecord(kind: string, id: string, archivedAt: string): Promise<boolean>;
  getTradingCases(): Promise<TradingCase[]>;
  getStatementImports(): Promise<StatementImport[]>;
  getReviewInstrumentMetadata(): Promise<{ id: string; symbol: string; assetClass: string; contractMultiplier: string }[]>;
  importStatements(statements: StatementImport[], cases: TradingCase[]): Promise<{ files: number; cases: number }>;
  createTradingCase(entry: TradingCase): Promise<void>;
  updateTradingCase(id: string, update: (entry: TradingCase) => TradingCase): Promise<TradingCase | null>;
  /** Moves the fills of `sourceIds` into `targetId` atomically and removes the source cases; `merge` builds the surviving entry and may throw to abort. */
  mergeTradingCases(targetId: string, sourceIds: string[], merge: (target: TradingCase, sources: TradingCase[]) => TradingCase): Promise<TradingCase | null>;
  getWeeklyReviews(): Promise<WeeklyReview[]>;
  createWeeklyReview(entry: WeeklyReview): Promise<void>;
  createResearchEntry(entry: ResearchEntry): Promise<void>;
  appendResearchReview(id: string, review: ResearchReview, reviewedAt: string): Promise<ResearchEntry | null>;
  getBrokerSnapshots(): Promise<BrokerSnapshot[]>;
  savePerformanceSample(sample: PerformanceSample): Promise<void>;
  getPerformanceHistory(limit?: number): Promise<PerformanceSample[]>;
  getBrokerSyncAttempts(): Promise<BrokerSyncAttempt[]>;
  saveBrokerSyncAttempt(attempt: BrokerSyncAttempt): Promise<void>;
  /** Filled orders (per leg) observed during their session; keyed by broker/environment/account/order, first-seen time preserved. */
  getBrokerOrderObservations(broker: string): Promise<BrokerOrderObservation[]>;
  saveBrokerOrderObservations(rows: readonly BrokerOrderObservation[]): Promise<void>;
  saveBrokerSnapshots(snapshots: BrokerSnapshot[]): Promise<void>;
  getTransactions(query?: TransactionQuery): Promise<StoredTransaction[]>;
  createTransaction(id: string, input: TransactionWrite): Promise<StoredTransaction>;
  updateTransaction(id: string, patch: TransactionPatch): Promise<StoredTransaction | null>;
  deleteTransaction(id: string): Promise<boolean>;
  rebuildPositions(): Promise<void>;
  getPositionProjections(): Promise<StoredPositionProjection[]>;
  saveConfigVersion(input: {
    generation: number;
    loadedAtMs: number;
    sha256: string;
    status: "active" | "invalid" | "retired";
    diffJson: string;
  }): Promise<void>;
  recordSourceHealth(input: SourceHealthInput): Promise<void>;
  writeNews(input: NewsWriteInput): Promise<NewsWriteResult>;
  getNews(instrumentId?: string, limit?: number, includeDuplicates?: boolean): Promise<NewsItem[]>;
  getNewsProvenance(newsId: string): Promise<StoredNewsProvenance[]>;
  recordLlmUsage(input: LlmUsageInput): Promise<void>;
  getLlmUsageSince(routeId: string, sinceMs: number): Promise<StoredLlmUsage[]>;
  getLlmCache(cacheKey: string): Promise<LlmCacheEntry | null>;
  putLlmCache(entry: LlmCacheEntry): Promise<void>;
  getLatestQuotes(instrumentId?: string): Promise<StoredQuoteRow[]>;
  getQuoteHistory(instrumentId: string, sourceId?: string, limit?: number, beforeMs?: number, fromMs?: number): Promise<StoredQuoteRow[]>;
  getCandles(instrumentId: string, sourceId?: string, timeframe?: string, limit?: number, beforeMs?: number, fromMs?: number): Promise<StoredCandleRow[]>;
  setCandleWarnings(instrumentId: string, sourceId: string, warnings: readonly string[], atMs: number): Promise<void>;
  getCandleWarnings(instrumentId: string, sourceId?: string): Promise<string[]>;
  maintainMarketHistory(maxRows?: number): Promise<number>;
  getLatestSourceHealth(sourceId?: string, capability?: string): Promise<StoredSourceHealthRow[]>;
  getSourceEgressUsageSince(sinceMs: number): Promise<StoredSourceEgressUsage[]>;
  getPasswordCredential(): Promise<StoredPasswordCredential | null>;
  initializePasswordCredential(input: {
    passwordHash: string;
    passwordSalt: string;
    isInitial: boolean;
    updatedAtMs: number;
  }): Promise<void>;
  updatePasswordCredential(input: {
    passwordHash: string;
    passwordSalt: string;
    isInitial: boolean;
    updatedAtMs: number;
  }): Promise<void>;
  getAppSettings(): Promise<StoredAppSetting[]>;
  saveAppSettings(rows: readonly StoredAppSetting[]): Promise<void>;
  deleteAppSettings(keys: readonly string[]): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}
