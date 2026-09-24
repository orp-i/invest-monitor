import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { setImmediate as yieldIo } from "node:timers/promises";

export type SqlValue = string | number | bigint | Uint8Array | null;
export interface SqlStatement {
  run(...values: SqlValue[]): { readonly lastInsertRowid?: number | bigint; readonly changes?: number };
  get(...values: SqlValue[]): Record<string, unknown> | undefined;
  all(...values: SqlValue[]): Record<string, unknown>[];
}
export interface SqlDatabase { exec(sql: string): unknown; prepare(sql: string): SqlStatement; close(): void }
type Row = Record<string, unknown>;
type Kind = "quotes" | "candles";
export interface MarketPartitionOptions { hotPath: string; archiveDirectory: string; now?: () => number }
type Open = (path: string, readOnly?: boolean) => SqlDatabase;
const DAY = 86400000;
const keys = { quotes: ["instrument_id", "source_id", "captured_at_ms"], candles: ["instrument_id", "source_id", "timeframe", "open_time_ms"] };
const timeColumn = { quotes: "captured_at_ms", candles: "open_time_ms" };
function transaction<T>(db: SqlDatabase, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try { const value = work(); db.exec("COMMIT"); return value; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}

// The catalog and each monthly block have their own durable commit. Publication
// precedes source removal; a crash can leave duplicates, never an absent copy.
// Reads merge natural keys, so interrupted migrations remain queryable.
export class MarketPartitions {
  public readonly hot: SqlDatabase;
  private readonly catalog: SqlDatabase;
  private readonly schema: string;
  private readonly columns: Record<Kind, string[]>;
  private readonly blocks = new Map<string, SqlDatabase>();
  private maintenanceRunning = false;
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly now: () => number;
  public constructor(private readonly options: MarketPartitionOptions, private readonly open: Open, legacy: SqlDatabase) {
    mkdirSync(dirname(options.hotPath), { recursive: true, mode: 0o700 });
    mkdirSync(options.archiveDirectory, { recursive: true, mode: 0o700 });
    this.now = options.now ?? Date.now;
    this.schema = (["quotes", "candles"] as const).map(kind => {
      const sql = String(legacy.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(kind)?.sql);
      return sql.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS").replace(/ REFERENCES \w+\(\w+\)/g, "") + ";";
    }).join("\n") + `
      CREATE INDEX IF NOT EXISTS idx_quotes_instrument_captured ON quotes(instrument_id, captured_at_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_quotes_age ON quotes(captured_at_ms);
      CREATE INDEX IF NOT EXISTS idx_candles_query ON candles(instrument_id, timeframe, open_time_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_candles_age ON candles(open_time_ms);
    `;
    this.hot = open(options.hotPath);
    this.hot.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-8192; PRAGMA journal_size_limit=8388608; ${this.schema}
      CREATE TABLE IF NOT EXISTS latest_quotes(instrument_id TEXT, source_id TEXT, captured_at_ms INTEGER, received_at_ms INTEGER, row_json TEXT, PRIMARY KEY(instrument_id,source_id)) WITHOUT ROWID;
    `);
    this.columns = Object.fromEntries((["quotes", "candles"] as const).map(kind => [kind, this.hot.prepare(`PRAGMA table_info(${kind})`).all().map(r => String(r.name)).filter(n => n !== "id")])) as Record<Kind, string[]>;
    this.catalog = open(join(options.archiveDirectory, "catalog.sqlite"));
    this.catalog.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-2048; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS chunks(kind TEXT NOT NULL, month TEXT NOT NULL, instrument_id TEXT NOT NULL, source_id TEXT NOT NULL, timeframe TEXT NOT NULL, min_ms INTEGER NOT NULL, max_ms INTEGER NOT NULL,
        PRIMARY KEY(kind,instrument_id,source_id,timeframe,month)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_chunks_lookup ON chunks(kind,instrument_id,max_ms DESC);
    `);
  }
  private month(ms: number): string { return new Date(ms).toISOString().slice(0, 7); }
  private block(month: string, write = false): SqlDatabase {
    if (!/^\d{4}-\d{2}$/.test(month)) throw Error("Invalid archive month");
    const cacheKey = `${month}:${write}`;
    let db = this.blocks.get(cacheKey);
    if (!db) {
      if (this.blocks.size >= 2) { const oldest = this.blocks.keys().next().value!; this.blocks.get(oldest)!.close(); this.blocks.delete(oldest); }
      db = this.open(join(this.options.archiveDirectory, `${month}.sqlite`), !write);
      if (write) db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-2048; PRAGMA journal_size_limit=4194304; ${this.schema}`);
      else db.exec("PRAGMA query_only=ON; PRAGMA cache_size=-2048; PRAGMA busy_timeout=5000;");
    } else this.blocks.delete(cacheKey);
    this.blocks.set(cacheKey, db); return db;
  }
  private insert(db: SqlDatabase, kind: Kind, rows: readonly Row[], verify = false): void {
    const columns = this.columns[kind];
    const update = columns.filter(c => !keys[kind].includes(c));
    // A history poll is not a price revision. Avoid rewriting every old month
    // solely because the same completed candles were received again.
    const observation = new Set(["received_at_ms", "clock_skew_ms", "skew_suspected", "freshness_basis", "clock_skew_tolerance_ms"]);
    const changed = kind === "candles" && !verify ? update.filter(c => !observation.has(c)) : update;
    const statement = db.prepare(`INSERT INTO ${kind}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})
      ON CONFLICT(${keys[kind].join(",")}) DO UPDATE SET ${update.map(c => `${c}=excluded.${c}`).join(",")}
      WHERE ${changed.map(c => `${kind}.${c} IS NOT excluded.${c}`).join(" OR ")}`);
    transaction(db, () => { for (const row of rows) statement.run(...columns.map(c => row[c] as SqlValue)); });
  }
  public write(kind: Kind, rows: readonly Row[], verify = false): void {
    const cutoff = this.now() - 30 * DAY;
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const month = Number(row[timeColumn[kind]]) >= cutoff ? "hot" : this.month(Number(row[timeColumn[kind]]));
      const group = groups.get(month) ?? []; group.push(row); groups.set(month, group);
    }
    for (const [month, group] of groups) {
      if (month === "hot") this.insert(this.hot, kind, group, verify);
      else {
        const block = this.block(month, true); this.insert(block, kind, group, verify);
        // Publishing only after the block is durable makes restart recovery safe.
        const publish = this.catalog.prepare(`INSERT INTO chunks VALUES(?,?,?,?,?,?,?) ON CONFLICT(kind,instrument_id,source_id,timeframe,month)
          DO UPDATE SET min_ms=MIN(min_ms,excluded.min_ms),max_ms=MAX(max_ms,excluded.max_ms)
          WHERE excluded.min_ms < min_ms OR excluded.max_ms > max_ms`);
        transaction(this.catalog, () => {
          for (const row of group) publish.run(kind, month, String(row.instrument_id), String(row.source_id), kind === "candles" ? String(row.timeframe) : "", Number(row[timeColumn[kind]]), Number(row[timeColumn[kind]]));
        });
      }
      if (verify) {
        const target = month === "hot" ? this.hot : this.block(month);
        const read = target.prepare(`SELECT ${this.columns[kind].join(",")} FROM ${kind} WHERE ${keys[kind].map(k => `${k}=?`).join(" AND ")}`);
        for (const row of group) {
          const saved = read.get(...keys[kind].map(k => row[k] as SqlValue));
          if (!saved || this.columns[kind].some(c => saved[c] !== row[c])) throw Error(`Market block verification failed: ${kind}/${month}`);
        }
      }
    }
    if (kind === "quotes") {
      const save = this.hot.prepare(`INSERT INTO latest_quotes VALUES(?,?,?,?,?) ON CONFLICT(instrument_id,source_id) DO UPDATE SET
        captured_at_ms=excluded.captured_at_ms,received_at_ms=excluded.received_at_ms,row_json=excluded.row_json
        WHERE excluded.captured_at_ms > captured_at_ms OR (excluded.captured_at_ms = captured_at_ms AND excluded.received_at_ms >= received_at_ms AND excluded.row_json IS NOT row_json)`);
      transaction(this.hot, () => { for (const row of rows) save.run(String(row.instrument_id), String(row.source_id), Number(row.captured_at_ms), Number(row.received_at_ms), JSON.stringify(row)); });
    }
  }
  public writeCandleBlocks(rows: readonly Row[]): Promise<void> {
    const pending = this.writeCandleBlocksInternal(rows);
    this.pendingWrites.add(pending);
    return pending.finally(() => this.pendingWrites.delete(pending));
  }
  private async writeCandleBlocksInternal(rows: readonly Row[]): Promise<void> {
    const groups = new Map<string, Row[]>(), cutoff = this.now() - 30 * DAY;
    for (const row of rows) {
      const month = Number(row.open_time_ms) >= cutoff ? "hot" : this.month(Number(row.open_time_ms));
      const group = groups.get(month) ?? []; group.push(row); groups.set(month, group);
    }
    // Publish recent history first and release the event loop between durable
    // monthly commits. HTTP/calendar requests must not wait for a whole backfill.
    for (const month of [...groups.keys()].sort().reverse()) { this.write("candles", groups.get(month)!); await yieldIo(); }
  }
  public latest(instrumentId?: string): Row[] {
    return this.hot.prepare(`SELECT row_json FROM latest_quotes ${instrumentId ? "WHERE instrument_id=?" : ""} ORDER BY instrument_id,source_id`)
      .all(...(instrumentId ? [instrumentId] : [])).map(r => JSON.parse(String(r.row_json)) as Row);
  }
  public read(kind: Kind, instrumentId: string, sourceId: string | undefined, timeframe: string | undefined, limit: number, beforeMs = Number.MAX_SAFE_INTEGER, fromMs = 0): Row[] {
    limit = Math.min(1000, Math.max(1, Math.floor(limit)));
    const time = timeColumn[kind];
    const clauses = ["instrument_id=?", ...(sourceId ? ["source_id=?"] : []), ...(timeframe ? ["timeframe=?"] : [])];
    const values: SqlValue[] = [instrumentId, ...(sourceId ? [sourceId] : []), ...(timeframe ? [timeframe] : [])];
    const query = (db: SqlDatabase) => db.prepare(`SELECT * FROM ${kind} WHERE ${clauses.join(" AND ")} AND ${time} < ? AND ${time} >= ? ORDER BY ${time} DESC, source_id DESC LIMIT ?`).all(...values, beforeMs, fromMs, limit);
    let rows = query(this.hot);
    const candidates = this.catalog.prepare(`SELECT month,MAX(max_ms) AS max_ms FROM chunks WHERE kind=? AND ${clauses.join(" AND ")} AND min_ms < ? AND max_ms >= ? GROUP BY month ORDER BY max_ms DESC`)
      .all(kind, ...values, beforeMs, fromMs);
    const merge = (extra: Row[]) => {
      const unique = new Map<string, Row>();
      // Hot rows take precedence over an older archive copy after interrupted rollover.
      for (const row of [...extra, ...rows]) unique.set(JSON.stringify(keys[kind].map(k => row[k])), row);
      rows = [...unique.values()].sort((a,b) => Number(b[time])-Number(a[time]) || String(b.source_id).localeCompare(String(a.source_id))).slice(0,limit);
    };
    for (const candidate of candidates) {
      if (rows.length >= limit && Number(candidate.max_ms) < Number(rows.at(-1)![time])) break;
      merge(query(this.block(String(candidate.month))));
    }
    return rows;
  }
  public async importLegacy(legacy: SqlDatabase): Promise<void> {
    for (const kind of ["quotes", "candles"] as const) {
      // The source survives until every selected row is committed and verified.
      for (;;) {
        const rows = legacy.prepare(`SELECT * FROM ${kind} LIMIT 1000`).all();
        if (!rows.length) break;
        this.write(kind, rows, true);
        const remove = legacy.prepare(`DELETE FROM ${kind} WHERE ${keys[kind].map(k => `${k}=?`).join(" AND ")}`);
        transaction(legacy, () => { for (const row of rows) remove.run(...keys[kind].map(k => row[k] as SqlValue)); });
        await yieldIo();
      }
    }
  }
  public async maintain(maxRows = 2000): Promise<number> {
    if (this.maintenanceRunning) return 0;
    this.maintenanceRunning = true; let moved = 0;
    try {
      for (const kind of ["quotes", "candles"] as const) {
        const rows = this.hot.prepare(`SELECT * FROM ${kind} WHERE ${timeColumn[kind]} < ? ORDER BY ${timeColumn[kind]} LIMIT ?`).all(this.now()-30*DAY, maxRows-moved);
        if (!rows.length) continue;
        this.write(kind, rows, true);
        const remove = this.hot.prepare(`DELETE FROM ${kind} WHERE ${keys[kind].map(k => `${k}=?`).join(" AND ")}`);
        transaction(this.hot, () => { for (const row of rows) remove.run(...keys[kind].map(k => row[k] as SqlValue)); });
        moved += rows.length; await yieldIo();
      }
      return moved;
    } finally { this.maintenanceRunning = false; }
  }
  public async close(): Promise<void> {
    await Promise.allSettled([...this.pendingWrites]);
    while (this.maintenanceRunning) await yieldIo();
    for (const db of this.blocks.values()) db.close(); this.blocks.clear(); this.hot.close(); this.catalog.close();
  }
}
