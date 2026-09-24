PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS research_entries (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS broker_snapshots (
  broker TEXT NOT NULL,
  account_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (broker, account_id, environment)
) STRICT;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS password_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_initial INTEGER NOT NULL CHECK (is_initial IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  encrypted INTEGER NOT NULL CHECK (encrypted IN (0, 1)),
  updated_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS config_versions (
  generation INTEGER PRIMARY KEY,
  loaded_at_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'invalid', 'retired')),
  diff_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS instruments (
  id TEXT PRIMARY KEY,
  asset_class TEXT NOT NULL,
  symbol TEXT NOT NULL,
  display_name TEXT NOT NULL,
  venue TEXT,
  base_asset TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  contract_multiplier TEXT NOT NULL,
  underlying_id TEXT REFERENCES instruments(id),
  precision_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  metadata_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'config' CHECK (origin IN ('config', 'user'))
) STRICT;

CREATE TABLE IF NOT EXISTS source_bindings (
  source_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  provider_symbol TEXT NOT NULL,
  priority INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  conversion_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  egress_profile TEXT NOT NULL,
  cadence_seconds INTEGER NOT NULL,
  stale_after_seconds INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  origin TEXT NOT NULL DEFAULT 'config' CHECK (origin IN ('config', 'user')),
  PRIMARY KEY (source_id, instrument_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL,
  instrument_id TEXT,
  capability TEXT,
  request_id TEXT NOT NULL,
  captured_at_ms INTEGER,
  received_at_ms INTEGER NOT NULL,
  http_status INTEGER,
  content_type TEXT,
  body_sha256 TEXT NOT NULL,
  raw_json TEXT,
  blob_ref TEXT,
  parse_status TEXT NOT NULL,
  egress_profile_used TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_raw_events_source_received
  ON raw_events(source_id, received_at_ms);

CREATE TABLE IF NOT EXISTS candle_quality (
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, source_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS quotes (
  id INTEGER PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  source_id TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  price TEXT,
  bid TEXT,
  ask TEXT,
  mid TEXT,
  day_open TEXT,
  day_high TEXT,
  day_low TEXT,
  previous_close TEXT,
  volume TEXT,
  quote_asset TEXT NOT NULL,
  converted_to_json TEXT,
  quality TEXT NOT NULL,
  freshness_status TEXT NOT NULL,
  clock_skew_ms INTEGER,
  skew_suspected INTEGER NOT NULL CHECK (skew_suspected IN (0, 1)),
  freshness_basis TEXT NOT NULL CHECK (freshness_basis IN ('capturedAt', 'receivedAt')),
  clock_skew_tolerance_ms INTEGER NOT NULL,
  raw_event_id INTEGER REFERENCES raw_events(id),
  UNIQUE(instrument_id, source_id, captured_at_ms)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_quotes_instrument_captured
  ON quotes(instrument_id, captured_at_ms DESC);

CREATE TABLE IF NOT EXISTS candles (
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  source_id TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  open_time_ms INTEGER NOT NULL,
  close_time_ms INTEGER NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  open TEXT NOT NULL,
  high TEXT NOT NULL,
  low TEXT NOT NULL,
  close TEXT NOT NULL,
  volume TEXT,
  trade_count INTEGER,
  session TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  converted_to_json TEXT,
  received_at_ms INTEGER NOT NULL,
  clock_skew_ms INTEGER,
  skew_suspected INTEGER NOT NULL CHECK (skew_suspected IN (0, 1)),
  freshness_basis TEXT NOT NULL CHECK (freshness_basis IN ('capturedAt', 'receivedAt')),
  clock_skew_tolerance_ms INTEGER NOT NULL,
  PRIMARY KEY (instrument_id, source_id, timeframe, open_time_ms)
) WITHOUT ROWID, STRICT;
CREATE INDEX IF NOT EXISTS idx_candles_query
  ON candles(instrument_id, timeframe, open_time_ms DESC);

CREATE TABLE IF NOT EXISTS option_contracts (
  instrument_id TEXT PRIMARY KEY REFERENCES instruments(id),
  underlying_instrument_id TEXT NOT NULL REFERENCES instruments(id),
  source_id TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  occ_symbol TEXT,
  right TEXT NOT NULL,
  exercise_style TEXT NOT NULL,
  settlement TEXT NOT NULL,
  expiration_ms INTEGER NOT NULL,
  strike TEXT NOT NULL,
  contract_multiplier TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  converted_to_json TEXT,
  definition_captured_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_option_contracts_chain
  ON option_contracts(underlying_instrument_id, expiration_ms, strike, right);

CREATE TABLE IF NOT EXISTS option_quotes (
  instrument_id TEXT NOT NULL REFERENCES option_contracts(instrument_id),
  source_id TEXT NOT NULL,
  captured_at_ms INTEGER NOT NULL,
  received_at_ms INTEGER NOT NULL,
  bid TEXT,
  ask TEXT,
  last_price TEXT,
  volume TEXT,
  open_interest TEXT,
  freshness_status TEXT NOT NULL,
  PRIMARY KEY (instrument_id, source_id, captured_at_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS option_greeks (
  instrument_id TEXT NOT NULL REFERENCES option_contracts(instrument_id),
  source_id TEXT NOT NULL,
  calculated_at_ms INTEGER NOT NULL,
  delta TEXT,
  gamma TEXT,
  theta TEXT,
  vega TEXT,
  rho TEXT,
  implied_volatility TEXT,
  model TEXT,
  PRIMARY KEY (instrument_id, source_id, calculated_at_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  content_text TEXT,
  summary TEXT,
  language TEXT NOT NULL,
  published_at_ms INTEGER,
  fetched_at_ms INTEGER NOT NULL,
  tags_json TEXT NOT NULL,
  sentiment TEXT NOT NULL,
  importance TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  duplicate_of TEXT REFERENCES news_items(id),
  enrichment_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_news_published
  ON news_items(published_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_news_content_hash
  ON news_items(content_hash);

CREATE TABLE IF NOT EXISTS news_provenance (
  id INTEGER PRIMARY KEY,
  news_id TEXT NOT NULL REFERENCES news_items(id),
  source_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  fetched_at_ms INTEGER NOT NULL,
  raw_event_id INTEGER REFERENCES raw_events(id),
  UNIQUE(news_id, source_id, url, content_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_news_provenance_news
  ON news_provenance(news_id, fetched_at_ms DESC);

CREATE TABLE IF NOT EXISTS news_instruments (
  news_id TEXT NOT NULL REFERENCES news_items(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  method TEXT NOT NULL CHECK (method IN ('rule', 'llm', 'manual')),
  confidence TEXT,
  PRIMARY KEY (news_id, instrument_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  institution TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('readonly', 'manual')),
  reporting_currency TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  last_sync_at_ms INTEGER,
  metadata_json TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  type TEXT NOT NULL,
  quantity TEXT NOT NULL,
  price TEXT,
  fees TEXT NOT NULL,
  currency TEXT NOT NULL,
  trade_at_ms INTEGER NOT NULL,
  settlement_at_ms INTEGER,
  external_id TEXT,
  import_hash TEXT NOT NULL,
  raw_ref TEXT,
  UNIQUE(account_id, import_hash)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_transactions_account_trade
  ON transactions(account_id, trade_at_ms);

CREATE TABLE IF NOT EXISTS positions (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  instrument_id TEXT NOT NULL REFERENCES instruments(id),
  quantity TEXT NOT NULL,
  average_cost TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  mark_price TEXT,
  market_value TEXT,
  realized_pnl TEXT NOT NULL,
  unrealized_pnl TEXT,
  quote_asset TEXT NOT NULL,
  as_of_ms INTEGER NOT NULL,
  freshness_status TEXT NOT NULL,
  PRIMARY KEY (account_id, instrument_id)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of_ms INTEGER NOT NULL,
  reporting_currency TEXT NOT NULL,
  cash_value TEXT NOT NULL,
  market_value TEXT NOT NULL,
  cost_basis TEXT NOT NULL,
  realized_pnl TEXT NOT NULL,
  unrealized_pnl TEXT NOT NULL,
  total_pnl TEXT NOT NULL,
  fx_source_id TEXT,
  freshness_status TEXT NOT NULL,
  UNIQUE(account_id, as_of_ms)
) STRICT;

CREATE TABLE IF NOT EXISTS source_health (
  source_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  success_rate TEXT NOT NULL,
  p50_latency_ms INTEGER,
  p95_latency_ms INTEGER,
  quota_used TEXT,
  circuit_state TEXT NOT NULL,
  last_success_at_ms INTEGER,
  last_error_json TEXT,
  clock_skew_median_ms INTEGER,
  clock_skew_status TEXT NOT NULL CHECK (clock_skew_status IN ('unknown', 'normal', 'suspected')),
  clock_skew_tolerance_ms INTEGER NOT NULL,
  egress_profile_used TEXT,
  PRIMARY KEY (source_id, capability, observed_at_ms)
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS llm_usage (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  route_id TEXT NOT NULL,
  content_hash TEXT,
  prompt_version TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  estimated_cost_usd TEXT,
  latency_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model TEXT NOT NULL,
  enrichment_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) WITHOUT ROWID, STRICT;

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  instrument_id TEXT,
  account_id TEXT,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  observed_value TEXT,
  threshold TEXT,
  source_id TEXT,
  fired_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  dedup_key TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_alerts_open
  ON alerts(status, severity, fired_at_ms DESC);
CREATE TABLE IF NOT EXISTS trading_review_cases (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trading_statement_imports (
  id TEXT PRIMARY KEY,
  imported_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS broker_sync_attempts (
  broker TEXT NOT NULL,
  mode TEXT NOT NULL,
  attempt_json TEXT NOT NULL,
  PRIMARY KEY (broker, mode)
);
CREATE TABLE IF NOT EXISTS broker_order_observations (
  broker TEXT NOT NULL,
  environment TEXT NOT NULL,
  account_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY (broker, environment, account_id, order_id)
);
CREATE TABLE IF NOT EXISTS trading_review_fills (
  fill_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES trading_review_cases(id)
);
CREATE TABLE IF NOT EXISTS trading_weekly_reviews (
  id TEXT PRIMARY KEY,
  recorded_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS performance_history (
  bucket_ms INTEGER PRIMARY KEY,
  sample_json TEXT NOT NULL
);
-- Small, bounded daily research datasets are isolated from quote/tick history.
CREATE TABLE IF NOT EXISTS research_series_cache (
  id TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  series_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS market_daily_reports (
  id TEXT PRIMARY KEY,
  report_date TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'archived')),
  report_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_daily_revisions (
  report_id TEXT NOT NULL REFERENCES market_daily_reports(id),
  revision INTEGER NOT NULL,
  report_date TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  status TEXT NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY (report_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_market_daily_revision_date ON market_daily_revisions(report_date, saved_at);

CREATE TABLE IF NOT EXISTS daily_inference_runs (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES market_daily_reports(id),
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  run_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_inference_report ON daily_inference_runs(report_id, created_at DESC);
CREATE TABLE IF NOT EXISTS daily_observations (
  id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES market_daily_reports(id),
  report_date TEXT NOT NULL,
  revision INTEGER NOT NULL,
  observation_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_daily_observation_date ON daily_observations(report_date, report_id);
CREATE TABLE IF NOT EXISTS daily_observation_revisions (
  observation_id TEXT NOT NULL REFERENCES daily_observations(id),
  revision INTEGER NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY (observation_id, revision)
);

CREATE TABLE IF NOT EXISTS research_board_records (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL,
  archived_at TEXT,
  PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS idx_research_board_active ON research_board_records(updated_at DESC) WHERE archived_at IS NULL;
