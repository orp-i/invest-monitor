import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MarketPartitions, type MarketPartitionOptions } from "./market-partitions.js";
import {
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  AccountSchema,
  InstrumentSchema,
  NewsEnrichmentSchema,
  NewsItemSchema,
  TransactionWriteSchema,
  replayMovingAverage,
  applyBrokerExpirations,
  SourceBindingSchema,
  type Candle,
  type Instrument,
  type NewsItem,
  type PositionLedgerTransaction,
  type Quote,
  type SourceBinding,
  type ResearchEntry,
  type TradingCase,
  type StatementImport,
  type WeeklyReview,
  type ResearchReview,
  type BrokerSnapshot,
  type BrokerSyncAttempt,
  type PerformanceSample,
} from "@invest/domain";
import type {
  StoredAppSetting,
  LlmCacheEntry,
  LlmUsageInput,
  NewsWriteInput,
  NewsWriteResult,
  RawEventInput,
  SourceHealthInput,
  StorageDriver,
  StoredInstrumentConfig,
  StoredCandleRow,
  StoredLlmUsage,
  StoredNewsProvenance,
  StoredPasswordCredential,
  StoredQuoteRow,
  StoredSourceEgressUsage,
  StoredSourceHealthRow,
  StoredPositionProjection,
  StoredTransaction,
  TransactionQuery,
  InstrumentOrigin,
  InstrumentReferenceCounts,
  UserInstrumentDeleteResult,
} from "./types.js";

type SqlValue = string | number | bigint | Uint8Array | null;

interface SqlStatement {
  run(...values: SqlValue[]): { readonly lastInsertRowid?: number | bigint; readonly changes?: number };
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
}

interface SqlDatabase {
  exec(sql: string): unknown;
  prepare(sql: string): SqlStatement;
  close(): void;
}

// Seek directly to each distinct indexed pair, then to its newest observation.
// GROUP BY/MAX and DISTINCT walk every historical entry in SQLite. All SQL
// identifiers here are internal constants; values remain bound parameters.
function latestIndexedRows(database: SqlDatabase, table: string, first: string, second: string, time: string, firstValue?: string): Record<string, unknown>[] {
  const prefix = firstValue ? `${first} = ? AND ` : "";
  const values: SqlValue[] = firstValue ? [firstValue] : [];
  const pair = `${first}, ${second}`;
  const base = `FROM ${table} WHERE ${prefix}${second} IS NOT NULL`;
  const firstGroup = database.prepare(`SELECT ${pair} ${base} ORDER BY ${pair} LIMIT 1`);
  const nextGroup = database.prepare(`SELECT ${pair} ${base} AND (${pair}) > (?, ?) ORDER BY ${pair} LIMIT 1`);
  const latest = database.prepare(`SELECT * FROM ${table} WHERE ${first} = ? AND ${second} = ? ORDER BY ${time} DESC LIMIT 1`);
  const rows: Record<string, unknown>[] = [];
  let group = firstGroup.get(...values);
  while (group) {
    const key = [String(group[first]), String(group[second])];
    const row = latest.get(...key);
    if (row) rows.push(row);
    group = nextGroup.get(...values, ...key);
  }
  return rows;
}

abstract class SqliteDriverBase implements StorageDriver {
  public abstract readonly kind: "node-sqlite" | "better-sqlite3";
  protected database: SqlDatabase | null = null;
  private transactionQueue = Promise.resolve();
  private market: MarketPartitions | null = null;
  protected openMarketDatabase: ((path: string, readOnly?: boolean) => SqlDatabase) | null = null;

  public constructor(protected readonly filePath: string, private readonly marketOptions?: MarketPartitionOptions) {}

  public abstract open(): Promise<void>;

  public async getTradingCases(): Promise<TradingCase[]> {
    return this.requireDatabase().prepare("SELECT entry_json FROM trading_review_cases ORDER BY updated_at DESC, id DESC").all()
      .map(row => JSON.parse(String(row.entry_json)) as TradingCase);
  }

  public async getStatementImports(): Promise<StatementImport[]> {
    return this.requireDatabase().prepare("SELECT entry_json FROM trading_statement_imports ORDER BY imported_at DESC, id").all()
      .map(row => JSON.parse(String(row.entry_json)) as StatementImport);
  }

  public async getReviewInstrumentMetadata(): Promise<{ id: string; symbol: string; assetClass: string; contractMultiplier: string }[]> {
    return this.requireDatabase().prepare("SELECT id, symbol, asset_class, contract_multiplier FROM instruments").all()
      .map(row => ({ id: String(row.id), symbol: String(row.symbol), assetClass: String(row.asset_class), contractMultiplier: String(row.contract_multiplier) }));
  }

  public async importStatements(statements: StatementImport[], cases: TradingCase[]): Promise<{ files: number; cases: number }> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase(); let fileCount = 0, caseCount = 0;
      for (const statement of statements) {
        fileCount += Number(db.prepare("INSERT OR IGNORE INTO trading_statement_imports (id, imported_at, entry_json) VALUES (?, ?, ?)")
          .run(statement.id, statement.importedAt, JSON.stringify(statement)).changes ?? 0);
      }
      for (const entry of cases) {
        if (db.prepare("SELECT id FROM trading_review_cases WHERE id = ?").get(entry.id)) continue;
        db.prepare("INSERT INTO trading_review_cases (id, updated_at, entry_json) VALUES (?, ?, ?)").run(entry.id, entry.updatedAt, JSON.stringify(entry));
        this.claimReviewFills(entry); caseCount++;
      }
      return { files: fileCount, cases: caseCount };
    });
  }

  private claimReviewFills(entry: TradingCase): void {
    const db = this.requireDatabase();
    for (const fill of entry.fills) {
      const owner = db.prepare("SELECT case_id FROM trading_review_fills WHERE fill_id = ?").get(fill.id);
      if (owner && owner.case_id !== entry.id) throw new Error("同一成交已关联其他复盘档案，请在原档案中继续记录");
      db.prepare("INSERT OR IGNORE INTO trading_review_fills (fill_id, case_id) VALUES (?, ?)").run(fill.id, entry.id);
    }
  }

  public async getTradingLessons(): Promise<import("@invest/domain").TradingLesson[]> {
    return this.requireDatabase().prepare("SELECT lesson_json FROM trading_lessons ORDER BY updated_at DESC, id").all().map(row => JSON.parse(String(row.lesson_json)));
  }

  public async createTradingLesson(lesson: import("@invest/domain").TradingLesson): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO trading_lessons (id, category, status, updated_at, lesson_json) VALUES (?, ?, ?, ?, ?)").run(lesson.id, lesson.category, lesson.status, lesson.updatedAt, JSON.stringify(lesson));
    });
  }

  public async updateTradingLesson(id: string, update: (lesson: import("@invest/domain").TradingLesson) => import("@invest/domain").TradingLesson): Promise<import("@invest/domain").TradingLesson | null> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      const row = db.prepare("SELECT lesson_json FROM trading_lessons WHERE id = ?").get(id);
      if (!row) return null;
      const next = update(JSON.parse(String(row.lesson_json)));
      db.prepare("UPDATE trading_lessons SET category = ?, status = ?, updated_at = ?, lesson_json = ? WHERE id = ?").run(next.category, next.status, next.updatedAt, JSON.stringify(next), id);
      return next;
    });
  }

  public async createTradingCase(entry: TradingCase): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO trading_review_cases (id, updated_at, entry_json) VALUES (?, ?, ?)").run(entry.id, entry.updatedAt, JSON.stringify(entry));
      this.claimReviewFills(entry);
    });
  }

  public async updateTradingCase(id: string, update: (entry: TradingCase) => TradingCase): Promise<TradingCase | null> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      const row = db.prepare("SELECT entry_json FROM trading_review_cases WHERE id = ?").get(id);
      if (!row) return null;
      const entry = update(JSON.parse(String(row.entry_json)) as TradingCase);
      this.claimReviewFills(entry);
      db.prepare("UPDATE trading_review_cases SET updated_at = ?, entry_json = ? WHERE id = ?").run(entry.updatedAt, JSON.stringify(entry), id);
      return entry;
    });
  }

  public async mergeTradingCases(targetId: string, sourceIds: string[], merge: (target: TradingCase, sources: TradingCase[]) => TradingCase): Promise<TradingCase | null> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      const load = (id: string) => { const row = db.prepare("SELECT entry_json FROM trading_review_cases WHERE id = ?").get(id); return row ? JSON.parse(String(row.entry_json)) as TradingCase : null; };
      const target = load(targetId);
      if (!target) return null;
      const sources = sourceIds.map(id => { const source = id === targetId ? null : load(id); if (!source) throw new Error("待合并档案不存在，请刷新后重新选择"); return source; });
      const entry = merge(target, sources);
      for (const id of sourceIds) {
        db.prepare("UPDATE trading_review_fills SET case_id = ? WHERE case_id = ?").run(targetId, id);
        db.prepare("DELETE FROM trading_review_cases WHERE id = ?").run(id);
      }
      this.claimReviewFills(entry);
      db.prepare("UPDATE trading_review_cases SET updated_at = ?, entry_json = ? WHERE id = ?").run(entry.updatedAt, JSON.stringify(entry), targetId);
      return entry;
    });
  }

  public async getWeeklyReviews(): Promise<WeeklyReview[]> {
    return this.requireDatabase().prepare("SELECT entry_json FROM trading_weekly_reviews ORDER BY recorded_at DESC, id DESC").all()
      .map(row => JSON.parse(String(row.entry_json)) as WeeklyReview);
  }

  public async createWeeklyReview(entry: WeeklyReview): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO trading_weekly_reviews (id, recorded_at, entry_json) VALUES (?, ?, ?)").run(entry.id, entry.recordedAt, JSON.stringify(entry));
    });
  }

  public async getResearchEntries(): Promise<ResearchEntry[]> {
    return this.requireDatabase().prepare("SELECT entry_json FROM research_entries ORDER BY created_at DESC, id DESC").all()
      .map(row => JSON.parse(String(row.entry_json)) as ResearchEntry);
  }

  public async getStudySeries(id: string): Promise<import("@invest/domain").StudySeries | null> {
    const row = this.requireDatabase().prepare("SELECT series_json FROM research_series_cache WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.series_json)) : null;
  }

  public async saveStudySeries(series: import("@invest/domain").StudySeries): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO research_series_cache (id, fetched_at, series_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET fetched_at = excluded.fetched_at, series_json = excluded.series_json")
        .run(series.id, series.fetchedAt, JSON.stringify(series));
    });
  }

  public async getMarketDailyReports(query: import("@invest/domain").MarketDailyQuery): Promise<import("@invest/domain").MarketDailyReport[]> {
    const status = query.status === "all" ? "" : query.status ? " AND status = ?" : " AND status != 'archived'";
    return this.requireDatabase().prepare(`SELECT report_json FROM market_daily_reports WHERE report_date BETWEEN ? AND ?${status} ORDER BY report_date DESC LIMIT ?`)
      .all(query.from, query.to, ...(query.status && query.status !== "all" ? [query.status] : []), query.limit).map(row => JSON.parse(String(row.report_json)));
  }

  public async getMarketDailyReport(id: string, revision?: number): Promise<import("@invest/domain").MarketDailyReport | null> {
    const row = revision === undefined
      ? this.requireDatabase().prepare("SELECT report_json FROM market_daily_reports WHERE id = ?").get(id)
      : this.requireDatabase().prepare("SELECT report_json FROM market_daily_revisions WHERE report_id = ? AND revision = ?").get(id, revision);
    return row ? JSON.parse(String(row.report_json)) : null;
  }

  public async getMarketDailyRevisions(id: string): Promise<import("@invest/domain").MarketDailyRevision[]> {
    // Only metadata is returned; a selected historical body is fetched separately.
    return this.requireDatabase().prepare("SELECT revision, saved_at, status, json_extract(report_json, '$.title') AS title, json_extract(report_json, '$.summary') AS summary, json_extract(report_json, '$.stance') AS stance FROM market_daily_revisions WHERE report_id = ? ORDER BY revision DESC LIMIT 100")
      .all(id).map(row => ({ revision: Number(row.revision), updatedAt: String(row.saved_at), status: String(row.status) as import("@invest/domain").MarketDailyWrite["status"], title: String(row.title), summary: String(row.summary), stance: String(row.stance) as import("@invest/domain").MarketDailyWrite["stance"] }));
  }

  public async getMarketDailyContext(query: import("@invest/domain").MarketDailyContextQuery): Promise<import("@invest/domain").MarketDailyReport[]> {
    // Select the revision known at the cutoff BEFORE filtering status. A later
    // withdrawal must not resurrect an older ready version in current context.
    return this.requireDatabase().prepare(`WITH known AS (
      SELECT report_json, report_date, status, ROW_NUMBER() OVER (PARTITION BY report_id ORDER BY revision DESC) AS rank
      FROM market_daily_revisions WHERE report_date BETWEEN ? AND ? AND saved_at <= ?
    ) SELECT report_json FROM known WHERE rank = 1 AND status = 'ready' ORDER BY report_date DESC LIMIT ?`)
      .all(query.from, query.to, query.asOf, query.limit).map(row => JSON.parse(String(row.report_json)));
  }

  public async saveMarketDailyReport(id: string, input: import("@invest/domain").MarketDailyWrite, expectedRevision: number): Promise<import("@invest/domain").MarketDailySaveResult> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      const row = db.prepare("SELECT report_json FROM market_daily_reports WHERE id = ?").get(id);
      const previous: import("@invest/domain").MarketDailyReport | null = row ? JSON.parse(String(row.report_json)) : null;
      if (!previous && expectedRevision !== 0) return { status: "missing" };
      if (previous && previous.revision !== expectedRevision) return { status: "revision-conflict" };
      if (previous && previous.date !== input.date) return { status: "date-immutable" };
      if (db.prepare("SELECT id FROM market_daily_reports WHERE report_date = ? AND id != ?").get(input.date, id)) return { status: "date-conflict" };
      const now = new Date().toISOString();
      const report: import("@invest/domain").MarketDailyReport = { ...input, id, revision: expectedRevision + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
      const json = JSON.stringify(report);
      db.prepare("INSERT INTO market_daily_reports (id,report_date,revision,status,report_json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,report_json=excluded.report_json")
        .run(id, input.date, report.revision, report.status, json);
      db.prepare("INSERT INTO market_daily_revisions (report_id,revision,report_date,saved_at,status,report_json) VALUES (?,?,?,?,?,?)")
        .run(id, report.revision, report.date, now, report.status, json);
      return { status: "saved", report };
    });
  }

  public async getStudyRecords(): Promise<import("@invest/domain").StudyRecord[]> {
    return this.requireDatabase().prepare("SELECT record_json FROM research_board_records WHERE archived_at IS NULL ORDER BY updated_at DESC, id").all()
      .map(row => JSON.parse(String(row.record_json)));
  }

  public async createDailyInferenceRun(run: import("@invest/domain").DailyInferenceRun): Promise<boolean> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      if (db.prepare("SELECT id FROM daily_inference_runs WHERE id = ?").get(run.id)) return false;
      db.prepare("INSERT INTO daily_inference_runs (id,report_id,created_at,status,run_json) VALUES (?,?,?,?,?)")
        .run(run.id, run.reportId, run.createdAt, run.status, JSON.stringify(run));
      return true;
    });
  }

  public async getDailyInferenceRun(id: string): Promise<import("@invest/domain").DailyInferenceRun | null> {
    const row = this.requireDatabase().prepare("SELECT run_json FROM daily_inference_runs WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.run_json)) : null;
  }

  public async getDailyInferenceRuns(reportId: string, limit: number): Promise<import("@invest/domain").DailyInferenceRunSummary[]> {
    return this.requireDatabase().prepare("SELECT json_remove(run_json, '$.input', '$.output') AS summary_json, json_extract(run_json, '$.output.macro') AS macro_json, json_extract(run_json, '$.output.decision') AS decision FROM daily_inference_runs WHERE report_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(reportId, Math.min(50, Math.max(1, limit))).map(row => ({ ...JSON.parse(String(row.summary_json)), macro: row.macro_json ? JSON.parse(String(row.macro_json)) : null, decision: row.decision ?? null }));
  }

  public async finishDailyInferenceRun(run: import("@invest/domain").DailyInferenceRun, observations: import("@invest/domain").DailyObservation[]): Promise<void> {
    await this.withTransaction(async () => {
      const db = this.requireDatabase();
      if (run.status === "running") throw new Error("Cannot finish a running inference");
      if (db.prepare("SELECT status FROM daily_inference_runs WHERE id = ?").get(run.id)?.status !== "running") return;
      run.observationChanges = { updated: [], created: [], skipped: [] };
      const sourcesChanged = run.input.reports.some(report => {
        const current = db.prepare("SELECT revision,status FROM market_daily_reports WHERE id = ?").get(report.id);
        return !current || Number(current.revision) !== report.revision || current.status !== "ready";
      });
      for (const observation of observations) {
        if (sourcesChanged || !this.writeDailyObservation(observation, observation.revision - 1)) { run.observationChanges.skipped.push(observation.id); continue; }
        run.observationChanges[observation.revision === 1 ? "created" : "updated"].push(observation.id);
      }
      db.prepare("UPDATE daily_inference_runs SET status = ?, run_json = ? WHERE id = ?").run(run.status, JSON.stringify(run), run.id);
    });
  }

  public async recoverDailyInferenceRuns(): Promise<void> {
    await this.withTransaction(async () => {
      const db = this.requireDatabase();
      for (const row of db.prepare("SELECT run_json FROM daily_inference_runs WHERE status = 'running'").all()) {
        const run: import("@invest/domain").DailyInferenceRun = JSON.parse(String(row.run_json));
        run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = "服务重启中断了上次推理，请手动重新分析。";
        db.prepare("UPDATE daily_inference_runs SET status = ?, run_json = ? WHERE id = ?").run(run.status, JSON.stringify(run), run.id);
      }
    });
  }

  public async createMergeAdviceRun(run: import("@invest/domain").MergeAdviceRun): Promise<boolean> {
    return this.withTransaction(async () => {
      const db = this.requireDatabase();
      if (db.prepare("SELECT id FROM review_merge_advice WHERE id = ?").get(run.id)) return false;
      db.prepare("INSERT INTO review_merge_advice (id,created_at,status,input_hash,run_json) VALUES (?,?,?,?,?)").run(run.id, run.createdAt, run.status, run.inputHash, JSON.stringify(run));
      return true;
    });
  }

  public async finishMergeAdviceRun(run: import("@invest/domain").MergeAdviceRun): Promise<void> {
    await this.withTransaction(async () => {
      const db = this.requireDatabase();
      if (run.status === "running") throw new Error("Cannot finish a running advice run");
      if (db.prepare("SELECT status FROM review_merge_advice WHERE id = ?").get(run.id)?.status !== "running") return;
      db.prepare("UPDATE review_merge_advice SET status = ?, run_json = ? WHERE id = ?").run(run.status, JSON.stringify(run), run.id);
    });
  }

  public async getMergeAdviceRun(id: string): Promise<import("@invest/domain").MergeAdviceRun | null> {
    const row = this.requireDatabase().prepare("SELECT run_json FROM review_merge_advice WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.run_json)) : null;
  }

  public async getMergeAdviceRuns(limit: number): Promise<import("@invest/domain").MergeAdviceRunSummary[]> {
    return this.requireDatabase().prepare("SELECT json_remove(run_json, '$.input') AS summary_json, json_array_length(run_json, '$.input.clusters') AS clusters, json_array_length(run_json, '$.input.fills') AS fills FROM review_merge_advice ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(Math.min(50, Math.max(1, limit))).map(row => ({ ...JSON.parse(String(row.summary_json)), clusters: Number(row.clusters ?? 0), fills: Number(row.fills ?? 0) }));
  }

  public async recoverMergeAdviceRuns(): Promise<void> {
    await this.withTransaction(async () => {
      const db = this.requireDatabase();
      for (const row of db.prepare("SELECT run_json FROM review_merge_advice WHERE status = 'running'").all()) {
        const run: import("@invest/domain").MergeAdviceRun = JSON.parse(String(row.run_json));
        run.status = "failed"; run.completedAt = new Date().toISOString(); run.error = "服务重启中断了上次分析，请重新分析。";
        db.prepare("UPDATE review_merge_advice SET status = ?, run_json = ? WHERE id = ?").run(run.status, JSON.stringify(run), run.id);
      }
    });
  }

  public async getDailyObservations(from: string, to: string, reportId?: string): Promise<import("@invest/domain").DailyObservation[]> {
    return this.requireDatabase().prepare(`SELECT observation_json FROM daily_observations WHERE report_date BETWEEN ? AND ?${reportId ? " AND report_id = ?" : ""} ORDER BY report_date DESC, id LIMIT 301`)
      .all(from, to, ...(reportId ? [reportId] : [])).map(row => JSON.parse(String(row.observation_json)));
  }

  public async saveDailyObservation(observation: import("@invest/domain").DailyObservation, expectedRevision: number): Promise<boolean> {
    return this.withTransaction(async () => this.writeDailyObservation(observation, expectedRevision));
  }

  private writeDailyObservation(observation: import("@invest/domain").DailyObservation, expectedRevision: number): boolean {
    const db = this.requireDatabase(), previous = db.prepare("SELECT revision, report_id FROM daily_observations WHERE id = ?").get(observation.id);
    if ((previous ? Number(previous.revision) : 0) !== expectedRevision || (previous && previous.report_id !== observation.reportId) || observation.revision !== expectedRevision + 1) return false;
    const json = JSON.stringify(observation);
    db.prepare("INSERT INTO daily_observations (id,report_id,report_date,revision,observation_json) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,observation_json=excluded.observation_json")
      .run(observation.id, observation.reportId, observation.reportDate, observation.revision, json);
    db.prepare("INSERT INTO daily_observation_revisions (observation_id,revision,observation_json) VALUES (?,?,?)").run(observation.id, observation.revision, json);
    return true;
  }

  public async getDailyObservationHistory(id: string): Promise<import("@invest/domain").DailyObservation[]> {
    return this.requireDatabase().prepare("SELECT observation_json FROM daily_observation_revisions WHERE observation_id = ? ORDER BY revision DESC LIMIT 100")
      .all(id).map(row => JSON.parse(String(row.observation_json)));
  }

  public async saveStudyRecord(record: import("@invest/domain").StudyRecord): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO research_board_records (kind, id, updated_at, record_json) VALUES (?, ?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET updated_at = excluded.updated_at, record_json = excluded.record_json, archived_at = NULL")
        .run(record.kind, record.value.id, record.value.updatedAt, JSON.stringify(record));
    });
  }

  public async archiveStudyRecord(kind: string, id: string, archivedAt: string): Promise<boolean> {
    return this.withTransaction(async () => (this.requireDatabase().prepare("UPDATE research_board_records SET archived_at = ? WHERE kind = ? AND id = ? AND archived_at IS NULL").run(archivedAt, kind, id).changes ?? 0) > 0);
  }

  public async createResearchEntry(entry: ResearchEntry): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO research_entries (id, created_at, entry_json) VALUES (?, ?, ?)")
        .run(entry.id, entry.createdAt, JSON.stringify(entry));
    });
  }

  public async appendResearchReview(id: string, review: ResearchReview, reviewedAt: string): Promise<ResearchEntry | null> {
    return this.withTransaction(async () => {
      const row = this.requireDatabase().prepare("SELECT entry_json FROM research_entries WHERE id = ?").get(id);
      if (!row) return null;
      const entry = JSON.parse(String(row.entry_json)) as ResearchEntry;
      entry.reviews.push({ ...review, reviewedAt });
      this.requireDatabase().prepare("UPDATE research_entries SET entry_json = ? WHERE id = ?").run(JSON.stringify(entry), id);
      return entry;
    });
  }

  public async getBrokerSnapshots(): Promise<BrokerSnapshot[]> {
    return this.requireDatabase().prepare("SELECT snapshot_json FROM broker_snapshots ORDER BY broker, account_id, environment").all()
      .map(row => applyBrokerExpirations(JSON.parse(String(row.snapshot_json)) as BrokerSnapshot));
  }

  public async getBrokerSyncAttempts(): Promise<BrokerSyncAttempt[]> {
    return this.requireDatabase().prepare("SELECT attempt_json FROM broker_sync_attempts").all()
      .map(row => JSON.parse(String(row.attempt_json)) as BrokerSyncAttempt);
  }

  public async getBrokerOrderObservations(broker: string): Promise<import("@invest/domain").BrokerOrderObservation[]> {
    return this.requireDatabase().prepare("SELECT observation_json FROM broker_order_observations WHERE broker = ? ORDER BY first_seen_at, order_id").all(broker)
      .map(row => JSON.parse(String(row.observation_json)) as import("@invest/domain").BrokerOrderObservation);
  }

  public async saveBrokerOrderObservations(rows: readonly import("@invest/domain").BrokerOrderObservation[]): Promise<void> {
    await this.withTransaction(async () => {
      const db = this.requireDatabase();
      for (const row of rows) {
        const previous = db.prepare("SELECT observation_json FROM broker_order_observations WHERE broker = ? AND environment = ? AND account_id = ? AND order_id = ?").get(row.broker, row.environment, row.accountId, row.orderId);
        const firstSeenAt = previous ? (JSON.parse(String(previous.observation_json)) as import("@invest/domain").BrokerOrderObservation).firstSeenAt : row.firstSeenAt;
        const merged = { ...row, firstSeenAt };
        db.prepare("INSERT INTO broker_order_observations (broker, environment, account_id, order_id, first_seen_at, last_seen_at, observation_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT(broker, environment, account_id, order_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, observation_json = excluded.observation_json")
          .run(merged.broker, merged.environment, merged.accountId, merged.orderId, merged.firstSeenAt, merged.lastSeenAt, JSON.stringify(merged));
      }
    });
  }

  public async saveBrokerSyncAttempt(attempt: BrokerSyncAttempt): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare("INSERT INTO broker_sync_attempts (broker, mode, attempt_json) VALUES (?, ?, ?) ON CONFLICT(broker, mode) DO UPDATE SET attempt_json = excluded.attempt_json")
        .run(attempt.broker, attempt.mode, JSON.stringify(attempt));
    });
  }

  public async savePerformanceSample(sample: PerformanceSample): Promise<void> {
    const db = this.requireDatabase();
    const time = Date.parse(sample.capturedAt), bucket = sample.scheduledFor ? Date.parse(sample.scheduledFor) : Math.floor(time / 300000) * 300000;
    if (!Number.isFinite(time) || !Number.isFinite(bucket) || bucket > time) throw new Error("Invalid performance timestamp");
    db.prepare("INSERT INTO performance_history (bucket_ms, sample_json) VALUES (?, ?) ON CONFLICT(bucket_ms) DO UPDATE SET sample_json = excluded.sample_json").run(bucket, JSON.stringify(sample));
    db.prepare("DELETE FROM performance_history WHERE bucket_ms < ?").run(time - 366 * 86400000);
  }

  public async getPerformanceHistory(limit = 10000): Promise<PerformanceSample[]> {
    return this.requireDatabase().prepare("SELECT sample_json FROM performance_history ORDER BY bucket_ms DESC LIMIT ?").all(Math.min(10000, Math.max(1, limit)))
      .reverse().map(row => JSON.parse(String(row.sample_json)) as PerformanceSample);
  }

  public async saveBrokerSnapshots(snapshots: BrokerSnapshot[]): Promise<void> {
    await this.withTransaction(async () => {
      const database = this.requireDatabase();
      for (const snapshot of snapshots) {
        const previous = database.prepare("SELECT snapshot_json FROM broker_snapshots WHERE broker = ? AND account_id = ? AND environment = ?")
          .get(snapshot.broker, snapshot.accountId, snapshot.environment);
        const trades = new Map<string, BrokerSnapshot["trades"][number]>();
        if (previous) for (const trade of (JSON.parse(String(previous.snapshot_json)) as BrokerSnapshot).trades) trades.set(trade.id, trade);
        for (const trade of snapshot.trades) trades.set(trade.id, trade);
        const prior = previous ? JSON.parse(String(previous.snapshot_json)) as BrokerSnapshot : undefined;
        const sizes = new Map<string, Set<string>>();
        for (const row of [...(prior?.positions ?? []), ...(prior?.trades ?? []), ...snapshot.positions, ...snapshot.trades]) {
          const symbol = row.symbol.replace(/\s+/g, "");
          if (/\d{6}[CP]\d{8}$/.test(symbol) && row.multiplier != null) sizes.set(symbol, new Set([...(sizes.get(symbol) ?? []), row.multiplier]));
        }
        const preserveSize = <T extends BrokerSnapshot["trades"][number] | BrokerSnapshot["positions"][number]>(row: T): T => {
          const known = sizes.get(row.symbol.replace(/\s+/g, ""));
          return row.multiplier == null && known?.size === 1 ? { ...row, multiplier: [...known][0]! } : row;
        };
        const merged = { ...snapshot, positions: snapshot.positions.map(preserveSize), trades: [...trades.values()].map(preserveSize).sort((a, b) => b.tradedAt.localeCompare(a.tradedAt) || a.id.localeCompare(b.id)) };
        database.prepare("INSERT INTO broker_snapshots (broker, account_id, environment, snapshot_json) VALUES (?, ?, ?, ?) ON CONFLICT(broker, account_id, environment) DO UPDATE SET snapshot_json = excluded.snapshot_json")
          .run(snapshot.broker, snapshot.accountId, snapshot.environment, JSON.stringify(merged));
      }
    });
  }

  public async migrate(): Promise<void> {
    const database = this.requireDatabase();
    database.exec(readSchemaSql());
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    applyClockSkewMigration(database);
    applyEgressObservabilityMigration(database);
    applyInstrumentOriginMigration(database);
    // Run after the legacy egress-column migration. This index serves both
    // group seeks and the bounded one-hour counter without scanning history.
    database.exec(`CREATE INDEX IF NOT EXISTS idx_health_egress_observed
      ON source_health(source_id, egress_profile_used, observed_at_ms)
      WHERE egress_profile_used IS NOT NULL`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_raw_events_latest
      ON raw_events(source_id,instrument_id,capability,received_at_ms DESC)`);
    ensureManualAccountInDatabase(database);
    await this.rebuildPositions();
    if (this.marketOptions && !this.market) {
      this.market = new MarketPartitions(this.marketOptions, this.openMarketDatabase!, database);
      await this.market.importLegacy(database);
    }
  }

  public withTransaction<T>(work: (driver: StorageDriver) => Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(async () => {
      const database = this.requireDatabase();
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = await work(this);
        database.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original failure.
        }
        throw error;
      }
    });
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  public async appendQuotes(rows: readonly Quote[]): Promise<void> {
    if (this.market) {
      this.market.write("quotes", rows.map(row => ({
        instrument_id: row.instrumentId, source_id: row.sourceId, provider_symbol: row.providerSymbol,
        captured_at_ms: Date.parse(row.capturedAt), received_at_ms: Date.parse(row.freshness.receivedAt),
        price: row.price, bid: row.bid, ask: row.ask, mid: row.mid, day_open: row.dayOpen, day_high: row.dayHigh,
        day_low: row.dayLow, previous_close: row.previousClose, volume: row.volume, quote_asset: row.quoteAsset,
        converted_to_json: row.convertedTo ? JSON.stringify(row.convertedTo) : null, quality: row.quality,
        freshness_status: row.freshness.status, clock_skew_ms: row.freshness.clockSkewMs, skew_suspected: row.freshness.skewSuspected ? 1 : 0,
        freshness_basis: row.freshness.freshnessBasis, clock_skew_tolerance_ms: row.freshness.clockSkewToleranceMs,
        raw_event_id: row.rawRef && /^\d+$/.test(row.rawRef) ? Number(row.rawRef) : null,
      })));
      return;
    }
    await this.withTransaction(async () => {
      const statement = this.requireDatabase().prepare(`
        INSERT INTO quotes (
          instrument_id, source_id, provider_symbol, captured_at_ms, received_at_ms,
          price, bid, ask, mid, day_open, day_high, day_low, previous_close, volume,
          quote_asset, converted_to_json, quality, freshness_status,
          clock_skew_ms, skew_suspected, freshness_basis, clock_skew_tolerance_ms,
          raw_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instrument_id, source_id, captured_at_ms) DO UPDATE SET
          received_at_ms = excluded.received_at_ms,
          price = excluded.price,
          bid = excluded.bid,
          ask = excluded.ask,
          mid = excluded.mid,
          day_open = excluded.day_open,
          day_high = excluded.day_high,
          day_low = excluded.day_low,
          previous_close = excluded.previous_close,
          volume = excluded.volume,
          quote_asset = excluded.quote_asset,
          converted_to_json = excluded.converted_to_json,
          quality = excluded.quality,
          freshness_status = excluded.freshness_status,
          clock_skew_ms = excluded.clock_skew_ms,
          skew_suspected = excluded.skew_suspected,
          freshness_basis = excluded.freshness_basis,
          clock_skew_tolerance_ms = excluded.clock_skew_tolerance_ms,
          raw_event_id = excluded.raw_event_id
      `);
      for (const row of rows) {
        statement.run(
          row.instrumentId,
          row.sourceId,
          row.providerSymbol,
          Date.parse(row.capturedAt),
          Date.parse(row.freshness.receivedAt),
          row.price,
          row.bid,
          row.ask,
          row.mid,
          row.dayOpen,
          row.dayHigh,
          row.dayLow,
          row.previousClose,
          row.volume,
          row.quoteAsset,
          row.convertedTo ? JSON.stringify(row.convertedTo) : null,
          row.quality,
          row.freshness.status,
          row.freshness.clockSkewMs,
          row.freshness.skewSuspected ? 1 : 0,
          row.freshness.freshnessBasis,
          row.freshness.clockSkewToleranceMs,
          row.rawRef && /^\d+$/.test(row.rawRef) ? Number(row.rawRef) : null,
        );
      }
    });
  }

  public async appendCandles(rows: readonly Candle[]): Promise<void> {
    if (this.market) {
      await this.market.writeCandleBlocks(rows.map(row => ({
        instrument_id: row.instrumentId, source_id: row.sourceId, timeframe: row.timeframe,
        open_time_ms: Date.parse(row.openTime), close_time_ms: Date.parse(row.closeTime), captured_at_ms: Date.parse(row.freshness.capturedAt),
        open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, trade_count: row.tradeCount,
        session: row.session, quote_asset: row.quoteAsset, converted_to_json: row.convertedTo ? JSON.stringify(row.convertedTo) : null,
        received_at_ms: Date.parse(row.freshness.receivedAt), clock_skew_ms: row.freshness.clockSkewMs, skew_suspected: row.freshness.skewSuspected ? 1 : 0,
        freshness_basis: row.freshness.freshnessBasis, clock_skew_tolerance_ms: row.freshness.clockSkewToleranceMs,
      })));
      return;
    }
    await this.withTransaction(async () => {
      const statement = this.requireDatabase().prepare(`
        INSERT INTO candles (
          instrument_id, source_id, timeframe, open_time_ms, close_time_ms, captured_at_ms,
          open, high, low, close, volume, trade_count, session, quote_asset,
          converted_to_json, received_at_ms, clock_skew_ms, skew_suspected,
          freshness_basis, clock_skew_tolerance_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(instrument_id, source_id, timeframe, open_time_ms) DO UPDATE SET
          close_time_ms = excluded.close_time_ms,
          captured_at_ms = excluded.captured_at_ms,
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume,
          trade_count = excluded.trade_count,
          session = excluded.session,
          quote_asset = excluded.quote_asset,
          converted_to_json = excluded.converted_to_json,
          received_at_ms = excluded.received_at_ms,
          clock_skew_ms = excluded.clock_skew_ms,
          skew_suspected = excluded.skew_suspected,
          freshness_basis = excluded.freshness_basis,
          clock_skew_tolerance_ms = excluded.clock_skew_tolerance_ms
      `);
      for (const row of rows) {
        statement.run(
          row.instrumentId,
          row.sourceId,
          row.timeframe,
          Date.parse(row.openTime),
          Date.parse(row.closeTime),
          Date.parse(row.freshness.capturedAt),
          row.open,
          row.high,
          row.low,
          row.close,
          row.volume,
          row.tradeCount,
          row.session,
          row.quoteAsset,
          row.convertedTo ? JSON.stringify(row.convertedTo) : null,
          Date.parse(row.freshness.receivedAt),
          row.freshness.clockSkewMs,
          row.freshness.skewSuspected ? 1 : 0,
          row.freshness.freshnessBasis,
          row.freshness.clockSkewToleranceMs,
        );
      }
    });
  }

  public async appendRawEvent(input: RawEventInput): Promise<number> {
    const digest = createHash("sha256").update(input.body).digest("hex");
    const previous = this.requireDatabase().prepare(`SELECT id,body_sha256 FROM raw_events
      WHERE source_id=? AND instrument_id IS ? AND capability IS ? ORDER BY received_at_ms DESC LIMIT 1`)
      .get(input.sourceId, input.instrumentId, input.capability);
    // Retain the original evidence once; quote/health observations still record
    // each successful fetch and its actual receipt time independently.
    if (previous?.body_sha256 === digest) return Number(previous.id);
    return this.withTransaction(async () => {
      const statement = this.requireDatabase().prepare(`
        INSERT INTO raw_events (
          source_id, instrument_id, capability, request_id, captured_at_ms,
          received_at_ms, http_status, content_type, body_sha256, raw_json,
          blob_ref, parse_status, egress_profile_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const result = statement.run(
        input.sourceId,
        input.instrumentId,
        input.capability,
        input.requestId,
        input.capturedAt ? Date.parse(input.capturedAt) : null,
        Date.parse(input.receivedAt),
        input.httpStatus,
        input.contentType,
        digest,
        input.rawJson,
        null,
        input.parseStatus,
        input.egressProfileUsed,
      );
      return Number(result.lastInsertRowid ?? 0);
    });
  }

  public async upsertInstrument(
    instrument: Instrument,
    updatedAtMs: number,
    origin: InstrumentOrigin = "config",
  ): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO instruments (
        id, asset_class, symbol, display_name, venue, base_asset, quote_asset,
        contract_multiplier, underlying_id, precision_json, tags_json, active,
        metadata_json, updated_at_ms, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        asset_class = excluded.asset_class,
        symbol = excluded.symbol,
        display_name = excluded.display_name,
        venue = excluded.venue,
        base_asset = excluded.base_asset,
        quote_asset = excluded.quote_asset,
        contract_multiplier = excluded.contract_multiplier,
        underlying_id = excluded.underlying_id,
        precision_json = excluded.precision_json,
        tags_json = excluded.tags_json,
        active = excluded.active,
        metadata_json = excluded.metadata_json,
        updated_at_ms = excluded.updated_at_ms
      WHERE instruments.origin = excluded.origin
    `).run(
      instrument.id,
      instrument.assetClass,
      instrument.symbol,
      instrument.displayName,
      instrument.venue,
      instrument.baseAsset,
      instrument.quoteAsset,
      instrument.contractMultiplier,
      instrument.underlyingId,
      JSON.stringify(instrument.precision),
      JSON.stringify(instrument.tags),
      instrument.active ? 1 : 0,
      JSON.stringify(instrument.metadata),
      updatedAtMs,
      origin,
    );
  }

  public async upsertSourceBinding(binding: SourceBinding, origin: InstrumentOrigin = "config"): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO source_bindings (
        source_id, instrument_id, provider_symbol, priority, capabilities_json,
        quote_asset, conversion_json, params_json, egress_profile,
        cadence_seconds, stale_after_seconds, enabled, origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id, instrument_id) DO UPDATE SET
        provider_symbol = excluded.provider_symbol,
        priority = excluded.priority,
        capabilities_json = excluded.capabilities_json,
        quote_asset = excluded.quote_asset,
        conversion_json = excluded.conversion_json,
        params_json = excluded.params_json,
        egress_profile = excluded.egress_profile,
        cadence_seconds = excluded.cadence_seconds,
        stale_after_seconds = excluded.stale_after_seconds,
        enabled = excluded.enabled
      WHERE source_bindings.origin = excluded.origin
    `).run(
      binding.sourceId,
      binding.instrumentId,
      binding.providerSymbol,
      binding.priority,
      JSON.stringify(binding.capabilities),
      binding.quoteAsset,
      JSON.stringify(binding.conversion),
      JSON.stringify(binding.params),
      binding.egressProfile,
      binding.cadenceSeconds,
      binding.staleAfterSeconds,
      binding.enabled ? 1 : 0,
      origin,
    );
  }

  public async syncConfigInstruments(
    instruments: readonly StoredInstrumentConfig[],
    updatedAtMs: number,
  ): Promise<void> {
    await this.withTransaction(async (driver) => {
      const desiredInstrumentIds = new Set(instruments.map((instrument) => instrument.id));
      const desiredBindings = new Set<string>();
      for (const instrument of instruments) {
        await driver.upsertInstrument(instrument, updatedAtMs, "config");
        for (const binding of instrument.sourceBindings) {
          desiredBindings.add(`${binding.sourceId}\u0000${binding.instrumentId}`);
          await driver.upsertSourceBinding(binding, "config");
        }
      }

      const database = this.requireDatabase();
      for (const row of database.prepare(`
        SELECT source_id, instrument_id FROM source_bindings WHERE origin = 'config'
      `).all()) {
        const key = `${stringValue(row.source_id)}\u0000${stringValue(row.instrument_id)}`;
        if (!desiredBindings.has(key)) {
          database.prepare(`
            DELETE FROM source_bindings
            WHERE source_id = ? AND instrument_id = ? AND origin = 'config'
          `).run(stringValue(row.source_id), stringValue(row.instrument_id));
        }
      }
      for (const row of database.prepare("SELECT id FROM instruments WHERE origin = 'config'").all()) {
        const id = stringValue(row.id);
        if (!desiredInstrumentIds.has(id)) {
          database.prepare("DELETE FROM instruments WHERE id = ? AND origin = 'config'").run(id);
        }
      }
    });
  }

  public async getUserInstruments(): Promise<StoredInstrumentConfig[]> {
    const database = this.requireDatabase();
    return database.prepare("SELECT * FROM instruments WHERE origin = 'user' ORDER BY updated_at_ms, id")
      .all()
      .map((row) => mapStoredInstrumentConfig(database, row));
  }

  public async getInstrumentOrigin(instrumentId: string): Promise<InstrumentOrigin | null> {
    const row = this.requireDatabase().prepare("SELECT origin FROM instruments WHERE id = ?").get(instrumentId);
    return row ? instrumentOrigin(row.origin) : null;
  }

  public async createUserInstrument(instrument: StoredInstrumentConfig, updatedAtMs: number): Promise<void> {
    await this.withTransaction(async (driver) => {
      const existing = this.requireDatabase().prepare("SELECT origin FROM instruments WHERE id = ?").get(instrument.id);
      if (existing) throw new Error(`instrument id already exists: ${instrument.id}`);
      await driver.upsertInstrument(instrument, updatedAtMs, "user");
      for (const binding of instrument.sourceBindings) await driver.upsertSourceBinding(binding, "user");
    });
  }

  public async updateUserInstrument(
    instrumentId: string,
    changes: { readonly displayName?: string; readonly active?: boolean; readonly tags?: readonly string[] },
    updatedAtMs: number,
  ): Promise<boolean> {
    const assignments: string[] = [];
    const values: SqlValue[] = [];
    if (changes.displayName !== undefined) {
      assignments.push("display_name = ?");
      values.push(changes.displayName);
    }
    if (changes.active !== undefined) {
      assignments.push("active = ?");
      values.push(changes.active ? 1 : 0);
    }
    if (changes.tags !== undefined) {
      assignments.push("tags_json = ?");
      values.push(JSON.stringify(changes.tags));
    }
    if (assignments.length === 0) return false;
    assignments.push("updated_at_ms = ?");
    values.push(updatedAtMs, instrumentId);
    const result = this.requireDatabase().prepare(`
      UPDATE instruments SET ${assignments.join(", ")}
      WHERE id = ? AND origin = 'user'
    `).run(...values);
    return (result.changes ?? 0) > 0;
  }

  public async deleteUserInstrument(instrumentId: string, hard: boolean): Promise<UserInstrumentDeleteResult> {
    return this.withTransaction(async () => {
      const database = this.requireDatabase();
      const row = database.prepare("SELECT origin FROM instruments WHERE id = ?").get(instrumentId);
      const emptyReferences = { transactions: 0, nonZeroPositions: 0 };
      if (!row) return { status: "not-found", references: emptyReferences };
      if (instrumentOrigin(row.origin) !== "user") return { status: "config-owned", references: emptyReferences };
      const references = instrumentReferences(database, instrumentId);
      if (!hard) {
        database.prepare(`
          UPDATE instruments SET active = 0, updated_at_ms = ?
          WHERE id = ? AND origin = 'user'
        `).run(Date.now(), instrumentId);
        return { status: "deactivated", references };
      }
      if (references.transactions > 0 || references.nonZeroPositions > 0) {
        return { status: "referenced", references };
      }
      database.prepare("DELETE FROM positions WHERE instrument_id = ?").run(instrumentId);
      database.prepare("DELETE FROM news_instruments WHERE instrument_id = ?").run(instrumentId);
      database.prepare(`
        DELETE FROM option_greeks WHERE instrument_id IN (
          SELECT instrument_id FROM option_contracts
          WHERE instrument_id = ? OR underlying_instrument_id = ?
        )
      `).run(instrumentId, instrumentId);
      database.prepare(`
        DELETE FROM option_quotes WHERE instrument_id IN (
          SELECT instrument_id FROM option_contracts
          WHERE instrument_id = ? OR underlying_instrument_id = ?
        )
      `).run(instrumentId, instrumentId);
      database.prepare(`
        DELETE FROM option_contracts WHERE instrument_id = ? OR underlying_instrument_id = ?
      `).run(instrumentId, instrumentId);
      database.prepare("DELETE FROM quotes WHERE instrument_id = ?").run(instrumentId);
      database.prepare("DELETE FROM candles WHERE instrument_id = ?").run(instrumentId);
      database.prepare("DELETE FROM source_bindings WHERE instrument_id = ? AND origin = 'user'").run(instrumentId);
      database.prepare("DELETE FROM instruments WHERE id = ? AND origin = 'user'").run(instrumentId);
      return { status: "deleted", references };
    });
  }

  public async ensureManualAccount(): Promise<void> {
    ensureManualAccountInDatabase(this.requireDatabase());
  }

  public async getTransactions(query: TransactionQuery = {}): Promise<StoredTransaction[]> {
    const clauses: string[] = [];
    const values: SqlValue[] = [];
    if (query.instrumentId !== undefined) {
      clauses.push("instrument_id = ?");
      values.push(query.instrumentId);
    }
    if (query.fromMs !== undefined) {
      clauses.push("trade_at_ms >= ?");
      values.push(query.fromMs);
    }
    if (query.toMs !== undefined) {
      clauses.push("trade_at_ms <= ?");
      values.push(query.toMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.requireDatabase().prepare(`
      SELECT * FROM transactions ${where}
      ORDER BY trade_at_ms, id
    `).all(...values).map(mapTransactionRow);
  }

  public async createTransaction(id: string, input: import("@invest/domain").TransactionWrite): Promise<StoredTransaction> {
    return this.withTransaction(async () => {
      const database = this.requireDatabase();
      database.prepare(`
        INSERT INTO transactions (
          id, account_id, instrument_id, type, quantity, price, fees,
          currency, trade_at_ms, settlement_at_ms, external_id, import_hash, raw_ref
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL)
      `).run(
        id,
        input.accountId,
        input.instrumentId,
        input.type,
        input.quantity,
        input.price,
        input.fees,
        input.currency,
        input.tradeAtMs,
        `manual:${id}`,
      );
      rebuildPositionsInDatabase(database);
      const created = database.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
      if (!created) throw new Error(`created transaction disappeared: ${id}`);
      return mapTransactionRow(created);
    });
  }

  public async updateTransaction(
    id: string,
    patch: import("@invest/domain").TransactionPatch,
  ): Promise<StoredTransaction | null> {
    return this.withTransaction(async () => {
      const database = this.requireDatabase();
      const existingRow = database.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
      if (!existingRow) return null;
      const existing = mapTransactionRow(existingRow);
      const merged = TransactionWriteSchema.parse({
        accountId: patch.accountId ?? existing.accountId,
        instrumentId: patch.instrumentId ?? existing.instrumentId,
        type: patch.type ?? existing.type,
        quantity: patch.quantity ?? existing.quantity,
        price: patch.price === undefined ? existing.price : patch.price,
        fees: patch.fees ?? existing.fees,
        currency: patch.currency ?? existing.currency,
        tradeAtMs: patch.tradeAtMs ?? existing.tradeAtMs,
      });
      database.prepare(`
        UPDATE transactions SET
          account_id = ?, instrument_id = ?, type = ?, quantity = ?, price = ?,
          fees = ?, currency = ?, trade_at_ms = ?
        WHERE id = ?
      `).run(
        merged.accountId,
        merged.instrumentId,
        merged.type,
        merged.quantity,
        merged.price,
        merged.fees,
        merged.currency,
        merged.tradeAtMs,
        id,
      );
      rebuildPositionsInDatabase(database);
      const updated = database.prepare("SELECT * FROM transactions WHERE id = ?").get(id);
      if (!updated) throw new Error(`updated transaction disappeared: ${id}`);
      return mapTransactionRow(updated);
    });
  }

  public async deleteTransaction(id: string): Promise<boolean> {
    return this.withTransaction(async () => {
      const database = this.requireDatabase();
      const result = database.prepare("DELETE FROM transactions WHERE id = ?").run(id);
      if ((result.changes ?? 0) === 0) return false;
      rebuildPositionsInDatabase(database);
      return true;
    });
  }

  public async rebuildPositions(): Promise<void> {
    await this.withTransaction(async () => {
      rebuildPositionsInDatabase(this.requireDatabase());
    });
  }

  public async getPositionProjections(): Promise<StoredPositionProjection[]> {
    return this.requireDatabase().prepare(`
      SELECT * FROM positions ORDER BY account_id, instrument_id
    `).all().map(mapPositionProjectionRow);
  }

  public async saveConfigVersion(input: {
    generation: number;
    loadedAtMs: number;
    sha256: string;
    status: "active" | "invalid" | "retired";
    diffJson: string;
  }): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO config_versions (generation, loaded_at_ms, sha256, status, diff_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(generation) DO UPDATE SET
        loaded_at_ms = excluded.loaded_at_ms,
        sha256 = excluded.sha256,
        status = excluded.status,
        diff_json = excluded.diff_json
    `).run(input.generation, input.loadedAtMs, input.sha256, input.status, input.diffJson);
  }

  public async recordSourceHealth(input: SourceHealthInput): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO source_health (
        source_id, capability, observed_at_ms, status, success_rate,
        p50_latency_ms, p95_latency_ms, quota_used, circuit_state,
        last_success_at_ms, last_error_json, clock_skew_median_ms,
        clock_skew_status, clock_skew_tolerance_ms, egress_profile_used
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceId,
      input.capability,
      Date.parse(input.observedAt),
      input.status,
      input.successRate,
      input.p50LatencyMs,
      input.p95LatencyMs,
      input.quotaUsed,
      input.circuitState,
      input.lastSuccessAt ? Date.parse(input.lastSuccessAt) : null,
      input.lastError === null ? null : JSON.stringify(input.lastError),
      input.clockSkewMedianMs,
      input.clockSkewStatus,
      input.clockSkewToleranceMs,
      input.egressProfileUsed,
    );
  }

  public async writeNews(input: NewsWriteInput): Promise<NewsWriteResult> {
    return this.withTransaction(async () => {
      const database = this.requireDatabase();
      const existing = database.prepare("SELECT * FROM news_items WHERE canonical_url = ?").get(input.item.canonicalUrl);
      const newsId = existing ? stringValue(existing.id) : input.item.id;
      if (!existing) {
        database.prepare(`
          INSERT INTO news_items (
            id, source_id, url, canonical_url, title, content_text, summary,
            language, published_at_ms, fetched_at_ms, tags_json, sentiment,
            importance, content_hash, duplicate_of, enrichment_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.item.id,
          input.item.sourceId,
          input.item.url,
          input.item.canonicalUrl,
          input.item.title,
          input.item.contentText,
          input.item.summary,
          input.item.language,
          input.item.publishedAt ? Date.parse(input.item.publishedAt) : null,
          Date.parse(input.item.fetchedAt),
          JSON.stringify(input.item.tags),
          input.item.sentiment,
          input.item.importance,
          input.item.contentHash,
          input.item.duplicateOf,
          JSON.stringify(input.item.enrichment),
        );
      } else if (isRuleEnrichment(existing.enrichment_json) && input.item.enrichment.providerId === null) {
        // Rules evolve as false positives are discovered. Refresh only derived
        // fields on an exact canonical match while preserving source content
        // and every provenance record.
        database.prepare(`
          UPDATE news_items SET
            summary = ?, tags_json = ?, sentiment = ?, importance = ?, enrichment_json = ?
          WHERE id = ?
        `).run(
          input.item.summary,
          JSON.stringify(input.item.tags),
          input.item.sentiment,
          input.item.importance,
          JSON.stringify(input.item.enrichment),
          newsId,
        );
        database.prepare("DELETE FROM news_instruments WHERE news_id = ? AND method = 'rule'").run(newsId);
      }
      const associationStatement = database.prepare(`
        INSERT INTO news_instruments (news_id, instrument_id, method, confidence)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(news_id, instrument_id) DO UPDATE SET
          method = excluded.method,
          confidence = excluded.confidence
      `);
      for (const association of input.associations) {
        associationStatement.run(newsId, association.instrumentId, association.method, association.confidence);
      }
      database.prepare(`
        INSERT OR IGNORE INTO news_provenance (
          news_id, source_id, url, title, content_hash, fetched_at_ms, raw_event_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        newsId,
        input.provenance.sourceId,
        input.provenance.url,
        input.provenance.title,
        input.provenance.contentHash,
        Date.parse(input.provenance.fetchedAt),
        input.provenance.rawEventId,
      );
      const row = database.prepare("SELECT * FROM news_items WHERE id = ?").get(newsId);
      if (!row) throw new Error(`news item ${newsId} was not persisted`);
      return {
        item: mapNewsRow(row, newsInstrumentIds(database, newsId)),
        inserted: !existing,
      };
    });
  }

  public async getNews(instrumentId?: string, limit = 100, includeDuplicates = false): Promise<NewsItem[]> {
    const clauses = includeDuplicates ? [] : ["n.duplicate_of IS NULL"];
    const values: SqlValue[] = [];
    if (instrumentId) {
      clauses.push("EXISTS (SELECT 1 FROM news_instruments ni WHERE ni.news_id = n.id AND ni.instrument_id = ?)");
      values.push(instrumentId);
    }
    values.push(Math.min(1_000, Math.max(1, limit)));
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const database = this.requireDatabase();
    const rows = database.prepare(`
      SELECT n.* FROM news_items n
      ${where}
      ORDER BY COALESCE(n.published_at_ms, n.fetched_at_ms) DESC, n.id DESC
      LIMIT ?
    `).all(...values);
    return rows.map((row) => mapNewsRow(row, newsInstrumentIds(database, stringValue(row.id))));
  }

  public async getNewsProvenance(newsId: string): Promise<StoredNewsProvenance[]> {
    return this.requireDatabase().prepare(`
      SELECT * FROM news_provenance
      WHERE news_id = ? ORDER BY fetched_at_ms ASC, id ASC
    `).all(newsId).map((row) => ({
      id: numberValue(row.id),
      newsId: stringValue(row.news_id),
      sourceId: stringValue(row.source_id),
      url: stringValue(row.url),
      title: stringValue(row.title),
      contentHash: stringValue(row.content_hash),
      fetchedAt: new Date(numberValue(row.fetched_at_ms)).toISOString(),
      rawEventId: row.raw_event_id === null || row.raw_event_id === undefined ? null : numberValue(row.raw_event_id),
    }));
  }

  public async recordLlmUsage(input: LlmUsageInput): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO llm_usage (
        provider_id, model, route_id, content_hash, prompt_version,
        input_tokens, output_tokens, estimated_cost_usd, latency_ms,
        status, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.providerId,
      input.model,
      input.routeId,
      input.contentHash,
      input.promptVersion,
      input.inputTokens,
      input.outputTokens,
      input.estimatedCostUsd,
      input.latencyMs,
      input.status,
      Date.parse(input.createdAt),
    );
  }

  public async getLlmUsageSince(routeId: string, sinceMs: number): Promise<StoredLlmUsage[]> {
    return this.requireDatabase().prepare(`
      SELECT * FROM llm_usage
      WHERE route_id = ? AND created_at_ms >= ?
      ORDER BY created_at_ms ASC, id ASC
    `).all(routeId, sinceMs).map(mapLlmUsage);
  }

  public async getLlmCache(cacheKey: string): Promise<LlmCacheEntry | null> {
    const row = this.requireDatabase().prepare("SELECT * FROM llm_cache WHERE cache_key = ?").get(cacheKey);
    return row ? mapLlmCache(row) : null;
  }

  public async putLlmCache(entry: LlmCacheEntry): Promise<void> {
    this.requireDatabase().prepare(`
      INSERT INTO llm_cache (
        cache_key, content_hash, prompt_version, schema_version,
        provider_id, model, enrichment_json, created_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        provider_id = excluded.provider_id,
        model = excluded.model,
        enrichment_json = excluded.enrichment_json,
        created_at_ms = excluded.created_at_ms
    `).run(
      entry.cacheKey,
      entry.contentHash,
      entry.promptVersion,
      entry.schemaVersion,
      entry.providerId,
      entry.model,
      JSON.stringify(entry.enrichment),
      Date.parse(entry.createdAt),
    );
  }

  public async getLatestQuotes(instrumentId?: string): Promise<StoredQuoteRow[]> {
    if (this.market) return this.market.latest(instrumentId).map(mapQuoteRow);
    const rows = latestIndexedRows(this.requireDatabase(), "quotes", "instrument_id", "source_id", "captured_at_ms", instrumentId);
    return rows.map(mapQuoteRow);
  }

  public async getQuoteHistory(instrumentId: string, sourceId?: string, limit = 200, beforeMs = Number.MAX_SAFE_INTEGER, fromMs = 0): Promise<StoredQuoteRow[]> {
    if (this.market) return this.market.read("quotes", instrumentId, sourceId, undefined, limit, beforeMs, fromMs).map(mapQuoteRow);
    const sourceClause = sourceId ? "AND source_id = ?" : "";
    const values: SqlValue[] = sourceId ? [instrumentId, sourceId, beforeMs, fromMs, limit] : [instrumentId, beforeMs, fromMs, limit];
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM quotes
      WHERE instrument_id = ? ${sourceClause} AND captured_at_ms < ? AND captured_at_ms >= ?
      ORDER BY captured_at_ms DESC
      LIMIT ?
    `).all(...values);
    return rows.map(mapQuoteRow);
  }

  public async setCandleWarnings(instrumentId: string, sourceId: string, warnings: readonly string[], atMs: number): Promise<void> {
    this.requireDatabase().prepare(`INSERT INTO candle_quality(instrument_id,source_id,warnings_json,updated_at_ms) VALUES(?,?,?,?)
      ON CONFLICT(instrument_id,source_id) DO UPDATE SET warnings_json=excluded.warnings_json,updated_at_ms=excluded.updated_at_ms
      WHERE candle_quality.warnings_json IS NOT excluded.warnings_json`).run(instrumentId, sourceId, JSON.stringify(warnings), atMs);
  }

  public async getCandleWarnings(instrumentId: string, sourceId?: string): Promise<string[]> {
    return this.requireDatabase().prepare(`SELECT warnings_json FROM candle_quality WHERE instrument_id=? ${sourceId ? "AND source_id=?" : ""}`)
      .all(instrumentId, ...(sourceId ? [sourceId] : [])).flatMap(row => JSON.parse(String(row.warnings_json)) as string[]);
  }

  public async getCandles(
    instrumentId: string,
    sourceId?: string,
    timeframe = "1m",
    limit = 200,
    beforeMs = Number.MAX_SAFE_INTEGER,
    fromMs = 0,
  ): Promise<StoredCandleRow[]> {
    if (this.market) return this.market.read("candles", instrumentId, sourceId, timeframe, limit, beforeMs, fromMs).map(mapCandleRow);
    const sourceClause = sourceId ? "AND source_id = ?" : "";
    const values: SqlValue[] = sourceId ? [instrumentId, sourceId, timeframe, beforeMs, fromMs, limit] : [instrumentId, timeframe, beforeMs, fromMs, limit];
    const rows = this.requireDatabase().prepare(`
      SELECT * FROM candles
      WHERE instrument_id = ? ${sourceClause} AND timeframe = ? AND open_time_ms < ? AND open_time_ms >= ?
      ORDER BY open_time_ms DESC
      LIMIT ?
    `).all(...values);
    return rows.map(mapCandleRow);
  }

  public async getLatestSourceHealth(sourceId?: string, capability?: string): Promise<StoredSourceHealthRow[]> {
    const rows = latestIndexedRows(this.requireDatabase(), "source_health", "source_id", "capability", "observed_at_ms", sourceId)
      .filter(row => !capability || row.capability === capability);
    return rows.map(mapHealthRow);
  }

  public async getSourceEgressUsageSince(sinceMs: number): Promise<StoredSourceEgressUsage[]> {
    const database = this.requireDatabase();
    const rows = latestIndexedRows(database, "source_health", "source_id", "egress_profile_used", "observed_at_ms");
    const count = database.prepare(`SELECT COUNT(*) AS count FROM source_health
      WHERE source_id = ? AND egress_profile_used = ? AND observed_at_ms >= ?`);
    return rows.map((row) => ({
      sourceId: stringValue(row.source_id),
      egressProfileUsed: stringValue(row.egress_profile_used) as StoredSourceEgressUsage["egressProfileUsed"],
      requestCountSince: numberValue(count.get(stringValue(row.source_id), stringValue(row.egress_profile_used), sinceMs)?.count),
      latestObservedAtMs: numberValue(row.observed_at_ms),
    }));
  }

  public async getPasswordCredential(): Promise<StoredPasswordCredential | null> {
    const row = this.requireDatabase().prepare(`
      SELECT password_hash, password_salt, is_initial, updated_at_ms
      FROM password_credentials
      WHERE id = 1
    `).get();
    return row ? mapPasswordCredential(row) : null;
  }

  public async initializePasswordCredential(input: {
    passwordHash: string;
    passwordSalt: string;
    isInitial: boolean;
    updatedAtMs: number;
  }): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare(`
        INSERT OR IGNORE INTO password_credentials (
          id, password_hash, password_salt, is_initial, updated_at_ms
        ) VALUES (1, ?, ?, ?, ?)
      `).run(
        input.passwordHash,
        input.passwordSalt,
        input.isInitial ? 1 : 0,
        input.updatedAtMs,
      );
    });
  }

  public async updatePasswordCredential(input: {
    passwordHash: string;
    passwordSalt: string;
    isInitial: boolean;
    updatedAtMs: number;
  }): Promise<void> {
    await this.withTransaction(async () => {
      this.requireDatabase().prepare(`
        UPDATE password_credentials
        SET password_hash = ?, password_salt = ?, is_initial = ?, updated_at_ms = ?
        WHERE id = 1
      `).run(
        input.passwordHash,
        input.passwordSalt,
        input.isInitial ? 1 : 0,
        input.updatedAtMs,
      );
    });
  }

  public async getAppSettings(): Promise<StoredAppSetting[]> {
    return this.requireDatabase().prepare("SELECT key, value, encrypted, updated_at_ms FROM app_settings ORDER BY key").all()
      .map(row => ({ key: stringValue(row.key), value: stringValue(row.value), encrypted: numberValue(row.encrypted) === 1, updatedAtMs: numberValue(row.updated_at_ms) }));
  }

  public async saveAppSettings(rows: readonly StoredAppSetting[]): Promise<void> {
    if (!rows.length) return;
    await this.withTransaction(async () => {
      const statement = this.requireDatabase().prepare(`
        INSERT INTO app_settings (key, value, encrypted, updated_at_ms) VALUES (?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at_ms = excluded.updated_at_ms
      `);
      for (const row of rows) statement.run(row.key, row.value, row.encrypted ? 1 : 0, row.updatedAtMs);
    });
  }

  public async deleteAppSettings(keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await this.withTransaction(async () => {
      const statement = this.requireDatabase().prepare("DELETE FROM app_settings WHERE key = ?");
      for (const key of keys) statement.run(key);
    });
  }

  public async ping(): Promise<boolean> {
    try {
      const row = this.requireDatabase().prepare("SELECT 1 AS ok").get();
      return row?.ok === 1;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.market?.close();
    this.market = null;
    this.database?.close();
    this.database = null;
  }

  public async maintainMarketHistory(maxRows = 2000): Promise<number> {
    return this.market?.maintain(maxRows) ?? 0;
  }

  protected setDatabase(database: SqlDatabase): void {
    this.database = database;
  }

  protected requireDatabase(): SqlDatabase {
    if (!this.database) throw new Error(`${this.kind} storage is not open`);
    return this.database;
  }
}

export class NodeSqliteDriver extends SqliteDriverBase {
  public readonly kind = "node-sqlite" as const;

  public async open(): Promise<void> {
    const sqlite = await import("node:sqlite");
    const database = new sqlite.DatabaseSync(this.filePath);
    this.openMarketDatabase = (path, readOnly = false) => new sqlite.DatabaseSync(path, { readOnly }) as unknown as SqlDatabase;
    this.setDatabase(database as unknown as SqlDatabase);
  }
}

export class BetterSqlite3Driver extends SqliteDriverBase {
  public readonly kind = "better-sqlite3" as const;

  public async open(): Promise<void> {
    const module = await import("better-sqlite3");
    const Database = module.default;
    this.openMarketDatabase = (path, readOnly = false) => new Database(path, { readonly: readOnly }) as unknown as SqlDatabase;
    this.setDatabase(new Database(this.filePath) as unknown as SqlDatabase);
  }
}

export function createStorageDriver(
  kind: "node-sqlite" | "better-sqlite3" = "node-sqlite",
  filePath = process.env.SQLITE_PATH ?? "./data/invest.sqlite",
  marketOptions?: MarketPartitionOptions,
): StorageDriver {
  return kind === "better-sqlite3"
    ? new BetterSqlite3Driver(filePath, marketOptions)
    : new NodeSqliteDriver(filePath, marketOptions);
}

function readSchemaSql(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const candidates = [
    `${modulePath.replace(/[/\\][^/\\]+$/, "")}/../schema.sql`,
    `${modulePath.replace(/[/\\][^/\\]+$/, "")}/schema.sql`,
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("storage schema.sql is missing");
  return readFileSync(path, "utf8");
}

function ensureManualAccountInDatabase(database: SqlDatabase): void {
  const account = AccountSchema.parse({
    id: "manual",
    displayName: "手工账户",
    adapterId: "manual",
    institution: "Manual",
    mode: "manual",
    reportingCurrency: "USD",
    enabled: true,
    lastSyncAt: null,
    freshness: null,
    metadata: {},
  });
  database.prepare(`
    INSERT INTO accounts (
      id, display_name, adapter_id, institution, mode,
      reporting_currency, enabled, last_sync_at_ms, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    account.id,
    account.displayName,
    account.adapterId,
    account.institution,
    account.mode,
    account.reportingCurrency,
    account.enabled ? 1 : 0,
    JSON.stringify(account.metadata),
  );
}

function rebuildPositionsInDatabase(database: SqlDatabase): void {
  const transactions = database.prepare(`
    SELECT * FROM transactions ORDER BY account_id, instrument_id, trade_at_ms, id
  `).all().map(mapTransactionRow);
  const grouped = new Map<string, StoredTransaction[]>();
  for (const transaction of transactions) {
    const key = `${transaction.accountId}\u0000${transaction.instrumentId}`;
    const rows = grouped.get(key) ?? [];
    rows.push(transaction);
    grouped.set(key, rows);
  }

  const projections = [...grouped.values()]
    .map((rows) => replayMovingAverage(rows))
    .filter((projection): projection is NonNullable<typeof projection> => projection !== null);

  // Full replacement is deliberate: positions is only a replayable projection.
  database.prepare("DELETE FROM positions").run();
  const insert = database.prepare(`
    INSERT INTO positions (
      account_id, instrument_id, quantity, average_cost, cost_basis,
      mark_price, market_value, realized_pnl, unrealized_pnl,
      quote_asset, as_of_ms, freshness_status
    ) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, 'unavailable')
  `);
  for (const projection of projections) {
    insert.run(
      projection.accountId,
      projection.instrumentId,
      projection.quantity,
      projection.averageCost,
      projection.costBasis,
      projection.realizedPnl,
      projection.quoteAsset,
      projection.asOfMs,
    );
  }
}

function applyClockSkewMigration(database: SqlDatabase): void {
  const applied = database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 1").get();
  if (applied) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(database, "quotes", "clock_skew_ms INTEGER");
    addColumnIfMissing(database, "quotes", "skew_suspected INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "quotes", "freshness_basis TEXT NOT NULL DEFAULT 'capturedAt'");
    addColumnIfMissing(database, "quotes", `clock_skew_tolerance_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CLOCK_SKEW_TOLERANCE_MS}`);

    addColumnIfMissing(database, "candles", "captured_at_ms INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "candles", "clock_skew_ms INTEGER");
    addColumnIfMissing(database, "candles", "skew_suspected INTEGER NOT NULL DEFAULT 0");
    addColumnIfMissing(database, "candles", "freshness_basis TEXT NOT NULL DEFAULT 'capturedAt'");
    addColumnIfMissing(database, "candles", `clock_skew_tolerance_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CLOCK_SKEW_TOLERANCE_MS}`);

    addColumnIfMissing(database, "source_health", "clock_skew_median_ms INTEGER");
    addColumnIfMissing(database, "source_health", "clock_skew_status TEXT NOT NULL DEFAULT 'unknown'");
    addColumnIfMissing(database, "source_health", `clock_skew_tolerance_ms INTEGER NOT NULL DEFAULT ${DEFAULT_CLOCK_SKEW_TOLERANCE_MS}`);

    database.exec(`
      UPDATE quotes
      SET clock_skew_ms = captured_at_ms - received_at_ms,
          skew_suspected = CASE WHEN captured_at_ms - received_at_ms > clock_skew_tolerance_ms THEN 1 ELSE 0 END,
          freshness_basis = CASE WHEN captured_at_ms - received_at_ms > clock_skew_tolerance_ms THEN 'receivedAt' ELSE 'capturedAt' END,
          quality = CASE
            WHEN quality = 'authoritative' AND captured_at_ms - received_at_ms > clock_skew_tolerance_ms THEN 'indicative'
            ELSE quality
          END
    `);
    database.exec(`
      UPDATE candles
      SET captured_at_ms = close_time_ms,
          clock_skew_ms = close_time_ms - received_at_ms,
          skew_suspected = CASE WHEN close_time_ms - received_at_ms > clock_skew_tolerance_ms THEN 1 ELSE 0 END,
          freshness_basis = CASE WHEN close_time_ms - received_at_ms > clock_skew_tolerance_ms THEN 'receivedAt' ELSE 'capturedAt' END
    `);

    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at_ms)
      VALUES (1, 'clock-skew-observability', ?)
    `).run(Date.now());
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

function applyEgressObservabilityMigration(database: SqlDatabase): void {
  const applied = database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 2").get();
  if (applied) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(database, "raw_events", "egress_profile_used TEXT");
    addColumnIfMissing(database, "source_health", "egress_profile_used TEXT");
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at_ms)
      VALUES (2, 'egress-observability', ?)
    `).run(Date.now());
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

function applyInstrumentOriginMigration(database: SqlDatabase): void {
  const applied = database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 3").get();
  if (applied) return;

  database.exec("BEGIN IMMEDIATE");
  try {
    addColumnIfMissing(
      database,
      "instruments",
      "origin TEXT NOT NULL DEFAULT 'config' CHECK (origin IN ('config', 'user'))",
    );
    addColumnIfMissing(
      database,
      "source_bindings",
      "origin TEXT NOT NULL DEFAULT 'config' CHECK (origin IN ('config', 'user'))",
    );
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at_ms)
      VALUES (3, 'instrument-origin', ?)
    `).run(Date.now());
    database.exec("COMMIT");
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the original migration failure.
    }
    throw error;
  }
}

function addColumnIfMissing(database: SqlDatabase, table: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all();
  const columnName = definition.split(/\s+/, 1)[0];
  if (columns.some((column) => String(column.name) === columnName)) return;
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function mapQuoteRow(row: Record<string, unknown>): StoredQuoteRow {
  return {
    id: numberValue(row.id),
    instrumentId: stringValue(row.instrument_id),
    sourceId: stringValue(row.source_id),
    providerSymbol: stringValue(row.provider_symbol),
    capturedAtMs: numberValue(row.captured_at_ms),
    receivedAtMs: numberValue(row.received_at_ms),
    price: nullableString(row.price),
    bid: nullableString(row.bid),
    ask: nullableString(row.ask),
    mid: nullableString(row.mid),
    dayOpen: nullableString(row.day_open),
    dayHigh: nullableString(row.day_high),
    dayLow: nullableString(row.day_low),
    previousClose: nullableString(row.previous_close),
    volume: nullableString(row.volume),
    quoteAsset: stringValue(row.quote_asset),
    convertedToJson: nullableString(row.converted_to_json),
    quality: stringValue(row.quality),
    freshnessStatus: stringValue(row.freshness_status),
    clockSkewMs: row.clock_skew_ms === null || row.clock_skew_ms === undefined ? null : numberValue(row.clock_skew_ms),
    skewSuspected: numberValue(row.skew_suspected) === 1,
    freshnessBasis: stringValue(row.freshness_basis) as "capturedAt" | "receivedAt",
    clockSkewToleranceMs: numberValue(row.clock_skew_tolerance_ms),
    rawEventId: row.raw_event_id === null || row.raw_event_id === undefined ? null : numberValue(row.raw_event_id),
  };
}

function mapCandleRow(row: Record<string, unknown>): StoredCandleRow {
  return {
    instrumentId: stringValue(row.instrument_id),
    sourceId: stringValue(row.source_id),
    timeframe: stringValue(row.timeframe),
    openTimeMs: numberValue(row.open_time_ms),
    closeTimeMs: numberValue(row.close_time_ms),
    capturedAtMs: numberValue(row.captured_at_ms),
    open: stringValue(row.open),
    high: stringValue(row.high),
    low: stringValue(row.low),
    close: stringValue(row.close),
    volume: nullableString(row.volume),
    tradeCount: row.trade_count === null || row.trade_count === undefined ? null : numberValue(row.trade_count),
    session: stringValue(row.session),
    quoteAsset: stringValue(row.quote_asset),
    convertedToJson: nullableString(row.converted_to_json),
    receivedAtMs: numberValue(row.received_at_ms),
    clockSkewMs: row.clock_skew_ms === null || row.clock_skew_ms === undefined ? null : numberValue(row.clock_skew_ms),
    skewSuspected: numberValue(row.skew_suspected) === 1,
    freshnessBasis: stringValue(row.freshness_basis) as "capturedAt" | "receivedAt",
    clockSkewToleranceMs: numberValue(row.clock_skew_tolerance_ms),
  };
}

function mapHealthRow(row: Record<string, unknown>): StoredSourceHealthRow {
  return {
    sourceId: stringValue(row.source_id),
    capability: stringValue(row.capability),
    observedAtMs: numberValue(row.observed_at_ms),
    status: stringValue(row.status),
    successRate: stringValue(row.success_rate),
    p50LatencyMs: row.p50_latency_ms === null || row.p50_latency_ms === undefined ? null : numberValue(row.p50_latency_ms),
    p95LatencyMs: row.p95_latency_ms === null || row.p95_latency_ms === undefined ? null : numberValue(row.p95_latency_ms),
    quotaUsed: nullableString(row.quota_used),
    circuitState: stringValue(row.circuit_state),
    lastSuccessAtMs: row.last_success_at_ms === null || row.last_success_at_ms === undefined ? null : numberValue(row.last_success_at_ms),
    lastErrorJson: nullableString(row.last_error_json),
    clockSkewMedianMs: row.clock_skew_median_ms === null || row.clock_skew_median_ms === undefined ? null : numberValue(row.clock_skew_median_ms),
    clockSkewStatus: stringValue(row.clock_skew_status) as "unknown" | "normal" | "suspected",
    clockSkewToleranceMs: numberValue(row.clock_skew_tolerance_ms),
    egressProfileUsed: nullableEgressName(row.egress_profile_used),
  };
}

function mapTransactionRow(row: Record<string, unknown>): StoredTransaction {
  return {
    id: stringValue(row.id),
    accountId: stringValue(row.account_id),
    instrumentId: stringValue(row.instrument_id),
    type: stringValue(row.type) as StoredTransaction["type"],
    quantity: stringValue(row.quantity),
    price: nullableString(row.price),
    fees: stringValue(row.fees),
    currency: stringValue(row.currency),
    tradeAtMs: numberValue(row.trade_at_ms),
    settlementAtMs: row.settlement_at_ms === null || row.settlement_at_ms === undefined
      ? null
      : numberValue(row.settlement_at_ms),
    externalId: nullableString(row.external_id),
    importHash: stringValue(row.import_hash),
    rawRef: nullableString(row.raw_ref),
  };
}

function mapPositionProjectionRow(row: Record<string, unknown>): StoredPositionProjection {
  return {
    id: `${stringValue(row.account_id)}:${stringValue(row.instrument_id)}`,
    accountId: stringValue(row.account_id),
    instrumentId: stringValue(row.instrument_id),
    quantity: stringValue(row.quantity),
    averageCost: stringValue(row.average_cost),
    costBasis: stringValue(row.cost_basis),
    markPrice: nullableString(row.mark_price),
    marketValue: nullableString(row.market_value),
    realizedPnl: stringValue(row.realized_pnl),
    unrealizedPnl: nullableString(row.unrealized_pnl),
    quoteAsset: stringValue(row.quote_asset),
    asOfMs: numberValue(row.as_of_ms),
    freshnessStatus: stringValue(row.freshness_status) as StoredPositionProjection["freshnessStatus"],
  };
}

function mapStoredInstrumentConfig(database: SqlDatabase, row: Record<string, unknown>): StoredInstrumentConfig {
  const instrument = InstrumentSchema.parse({
    id: stringValue(row.id),
    assetClass: stringValue(row.asset_class),
    symbol: stringValue(row.symbol),
    displayName: stringValue(row.display_name),
    venue: nullableString(row.venue),
    baseAsset: stringValue(row.base_asset),
    quoteAsset: stringValue(row.quote_asset),
    contractMultiplier: stringValue(row.contract_multiplier),
    underlyingId: nullableString(row.underlying_id),
    precision: jsonValue(row.precision_json),
    tags: jsonValue(row.tags_json),
    active: numberValue(row.active) === 1,
    metadata: jsonValue(row.metadata_json),
  });
  const sourceBindings = database.prepare(`
    SELECT * FROM source_bindings
    WHERE instrument_id = ? AND origin = 'user'
    ORDER BY priority, source_id
  `).all(instrument.id).map((binding) => SourceBindingSchema.parse({
    sourceId: stringValue(binding.source_id),
    instrumentId: stringValue(binding.instrument_id),
    providerSymbol: stringValue(binding.provider_symbol),
    priority: numberValue(binding.priority),
    capabilities: jsonValue(binding.capabilities_json),
    quoteAsset: stringValue(binding.quote_asset),
    conversion: jsonValue(binding.conversion_json),
    params: jsonValue(binding.params_json),
    egressProfile: stringValue(binding.egress_profile),
    egressFallback: [],
    cadenceSeconds: numberValue(binding.cadence_seconds),
    staleAfterSeconds: numberValue(binding.stale_after_seconds),
    enabled: numberValue(binding.enabled) === 1,
  }));
  return {
    ...instrument,
    sourceBindings,
    panelId: "other",
    watch: true,
    origin: instrumentOrigin(row.origin),
    shadowed: false,
  };
}

function instrumentReferences(database: SqlDatabase, instrumentId: string): InstrumentReferenceCounts {
  const transactionRow = database.prepare(`
    SELECT COUNT(*) AS count FROM transactions WHERE instrument_id = ?
  `).get(instrumentId);
  const positionRows = database.prepare(`
    SELECT quantity FROM positions WHERE instrument_id = ?
  `).all(instrumentId);
  return {
    transactions: numberValue(transactionRow?.count ?? 0),
    nonZeroPositions: positionRows.filter((row) => !isZeroDecimalString(stringValue(row.quantity))).length,
  };
}

function isZeroDecimalString(value: string): boolean {
  return /^-?0(?:\.0+)?$/.test(value);
}

function instrumentOrigin(value: unknown): InstrumentOrigin {
  return value === "user" ? "user" : "config";
}

function newsInstrumentIds(database: SqlDatabase, newsId: string): string[] {
  return database.prepare(`
    SELECT instrument_id FROM news_instruments
    WHERE news_id = ? ORDER BY instrument_id
  `).all(newsId).map((row) => stringValue(row.instrument_id));
}

function mapNewsRow(row: Record<string, unknown>, instrumentIds: readonly string[]): NewsItem {
  return NewsItemSchema.parse({
    id: stringValue(row.id),
    sourceId: stringValue(row.source_id),
    url: stringValue(row.url),
    canonicalUrl: stringValue(row.canonical_url),
    title: stringValue(row.title),
    contentText: nullableString(row.content_text),
    summary: nullableString(row.summary),
    language: stringValue(row.language),
    publishedAt: row.published_at_ms === null || row.published_at_ms === undefined
      ? null
      : new Date(numberValue(row.published_at_ms)).toISOString(),
    fetchedAt: new Date(numberValue(row.fetched_at_ms)).toISOString(),
    instrumentIds,
    tags: jsonStringArray(row.tags_json),
    sentiment: stringValue(row.sentiment),
    importance: stringValue(row.importance),
    contentHash: stringValue(row.content_hash),
    duplicateOf: nullableString(row.duplicate_of),
    enrichment: jsonValue(row.enrichment_json),
  });
}

function mapLlmUsage(row: Record<string, unknown>): StoredLlmUsage {
  return {
    id: numberValue(row.id),
    providerId: stringValue(row.provider_id),
    model: stringValue(row.model),
    routeId: stringValue(row.route_id),
    contentHash: nullableString(row.content_hash),
    promptVersion: stringValue(row.prompt_version),
    inputTokens: numberValue(row.input_tokens),
    outputTokens: numberValue(row.output_tokens),
    estimatedCostUsd: nullableString(row.estimated_cost_usd),
    latencyMs: numberValue(row.latency_ms),
    status: stringValue(row.status),
    createdAt: new Date(numberValue(row.created_at_ms)).toISOString(),
  };
}

function mapLlmCache(row: Record<string, unknown>): LlmCacheEntry {
  return {
    cacheKey: stringValue(row.cache_key),
    contentHash: stringValue(row.content_hash),
    promptVersion: stringValue(row.prompt_version),
    schemaVersion: stringValue(row.schema_version),
    providerId: stringValue(row.provider_id),
    model: stringValue(row.model),
    enrichment: NewsEnrichmentSchema.parse(jsonValue(row.enrichment_json)),
    createdAt: new Date(numberValue(row.created_at_ms)).toISOString(),
  };
}

function mapPasswordCredential(row: Record<string, unknown>): StoredPasswordCredential {
  return {
    passwordHash: stringValue(row.password_hash),
    passwordSalt: stringValue(row.password_salt),
    isInitial: numberValue(row.is_initial) === 1,
    updatedAtMs: numberValue(row.updated_at_ms),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableEgressName(value: unknown): "direct" | "corp" | "vpn" | null {
  return value === "direct" || value === "corp" || value === "vpn" ? value : null;
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRuleEnrichment(value: unknown): boolean {
  const parsed = jsonValue(value);
  return typeof parsed === "object"
    && parsed !== null
    && "providerId" in parsed
    && parsed.providerId === null;
}

function jsonStringArray(value: unknown): string[] {
  const parsed = jsonValue(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function numberValue(value: unknown): number {
  return typeof value === "bigint" ? Number(value) : Number(value);
}
