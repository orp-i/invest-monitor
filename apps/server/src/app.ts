import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import {
  computeFreshness,
  computeTradeFreshness,
  candleChartWindow,
  dailyPerformanceCandles,
  performanceSchedule,
  PERFORMANCE_CANDLE_TIME_ZONE,
  DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
  InstrumentCandidateSchema,
  PositionSchema,
  QuoteSchema,
  CandleSchema,
  FreshnessSchema,
  TransactionPatchSchema,
  TransactionWriteSchema,
  ViewDescriptorSchema,
  ResearchWriteSchema,
  ResearchReviewSchema,
  type ResearchEntry,
  newYorkTime,
  riskExposureReference,
  type MarketQuote,
  type BrokerApiId,
  type BrokerConnectionStatus,
  type SettingsGroupId,
  type SettingsGroupStatus,
  type SettingsTestResult,
  summarizePortfolio,
  valuePosition,
  type Capability,
  type Freshness,
  type FreshnessClass,
  type InstrumentCandidate,
  type NewsItem,
  type PositionValuationInput,
  type Quote,
  type SourceBinding,
} from "@invest/domain";
import {
  ConfigManager,
  ConfigRegistry,
  EgressProfileSchema,
  InstrumentConfigSchema,
  type AppConfig,
  type ConfigSnapshot,
  type InstrumentConfig,
  type SourceConfig,
} from "@invest/config";
import type { EgressName, EgressProfile } from "@invest/config";
import { EgressDispatcherPool, EgressHttpClient, checkProxyListener } from "@invest/egress";
import { createAdapterRegistry, refreshTradierClock, tradierCalendarDay, type AdapterContext, type AdapterRegistry } from "@invest/adapters";
import { CollectorScheduler, type SchedulerEvent } from "@invest/collector";
import { IntelScheduler } from "@invest/intel";
import {
  createStorageDriver,
  type StorageDriver,
  type StoredPasswordCredential,
  type StoredQuoteRow,
  type StoredSourceHealthRow,
  type StoredInstrumentConfig,
  type StoredPositionProjection,
  type StoredTransaction,
} from "@invest/storage";
import { SseEventHub, writeEvent } from "./events.js";
import { brokerConnections, probeBroker, syncBroker } from "./brokers.js";
import { schwabAuthorizeUrl, schwabExchangeCode } from "./brokers-schwab.js";
import { createSecretBox } from "./secret-box.js";
import { createSettingsService, type SettingsService } from "./settings.js";
import { settingsRequest } from "./settings-api.js";
import { createStaticWeb, resolveWebDistDirectory } from "./static-web.js";
import { ensureConfigFile } from "./bootstrap-config.js";
import { brokerSyncs, brokerWorkspaceData, runBrokerSync } from "./broker-status.js";
import { closeSyncDue, sessionCloseSyncPlan, setCloseSyncStatus, CLOSE_SYNC_LEAD_MS } from "./session-close-sync.js";
import { applyTradierEnvironment } from "./tradier-config.js";
import { tradierMarketData } from "./market-data.js";
import { researchBoardRequest, researchSeriesRequest } from "./research-market.js";
import { marketDailyRequest } from "./market-daily.js";
import { DailyInferenceService } from "./daily-inference.js";
import { dailyLlmProvider, type DailyLlmProvider } from "./daily-llm.js";
import { dailyLlmEgressProfiles } from "./daily-llm-egress.js";
import { syncHeldInstruments, heldQuoteInstrumentIds } from "./held-instruments.js";
import { syncAutomaticTradingCases } from "./auto-trading-review.js";
import { currentPerformance, recordPerformance, createPerformanceRecorder, refreshPerformanceBrokers } from "./performance.js";
import { riskExposureData, warmRiskBetas, type RiskExposureDeps } from "./risk-exposure.js";
import { tradingReviewRequest } from "./trading-review.js";
import { serviceLog } from "./logger.js";

const FEDERAL_RESERVE_URL = "https://www.federalreserve.gov/feeds/press_all.xml";
const CORP_MARKET_PROBE_URL = "https://data-api.binance.vision/api/v3/ticker/24hr?symbol=BTCUSDT";
const VPN_PROBE_URL = "https://api.binance.com/api/v3/ping";
const SESSION_COOKIE_NAME = "invest_session";
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const EGRESS_FALLBACK_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_INITIAL_PASSWORD = "123456";
const MIN_PASSWORD_LENGTH = 6;
const MAX_PASSWORD_LENGTH = 1024;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = {
  N: 16_384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
} as const;
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_INITIAL_BACKOFF_MS = 30_000;
const LOGIN_MAX_BACKOFF_MS = 15 * 60_000;

type AuthMode = "off" | "password" | "token";

export interface RuntimeOptions {
  readonly configPath?: string;
  readonly sqlitePath?: string;
  readonly storageDriver?: "node-sqlite" | "better-sqlite3";
  readonly host?: string;
  readonly port?: number;
}

export interface Runtime {
  readonly configManager: ConfigManager;
  readonly storage: StorageDriver;
  readonly scheduler: CollectorScheduler;
  readonly intel: IntelScheduler;
  readonly httpClient: EgressHttpClient;
  readonly adapters: AdapterRegistry;
  readonly server: Server;
  readonly events: SseEventHub;
  readonly port: number;
  close(): Promise<void>;
}

interface HttpDependencies {
  readonly sessionSchedule?: (nyDate: string) => import("@invest/domain").SessionDaySchedule | undefined;
  configManager: ConfigManager;
  storage: StorageDriver;
  scheduler: CollectorScheduler;
  intel: IntelScheduler;
  httpClient: EgressHttpClient;
  adapters: AdapterRegistry;
  authMode: AuthMode;
  authToken: string | null;
  passwordAuth: PasswordAuthState | null;
  loginRateLimiter: LoginRateLimiter;
  sessions: SessionStore;
  secureSessionCookie: boolean;
  events: SseEventHub;
  dailyInference?: DailyInferenceService;
  /** Account settings (encrypted overrides + env fallback); absent in isolated tests. */
  settings?: SettingsService;
  dailyLlm?: DailyLlmProvider;
  staticWeb?: ReturnType<typeof createStaticWeb>;
}

interface PasswordAuthState {
  credential: StoredPasswordCredential;
}

export async function createRuntime(options: RuntimeOptions = {}): Promise<Runtime> {
  const configPath = resolve(options.configPath ?? process.env.APP_CONFIG_PATH ?? "config/portfolio.yaml");
  const sqlitePath = resolve(options.sqlitePath ?? process.env.SQLITE_PATH ?? "data/invest.sqlite");
  await mkdir(dirname(sqlitePath), { recursive: true });
  // Source and bundle installs start from the example config; Docker mounts a real one read-only.
  const bootstrap = await ensureConfigFile(configPath, resolve(process.env.APP_CONFIG_EXAMPLE_PATH ?? "config/portfolio.example.yaml")).catch(error => { log("config.bootstrap_failed", { error: errorMessage(error) }); return "missing" as const; });
  if (bootstrap === "created") log("config.bootstrap_created", { path: configPath });
  const storage = createStorageDriver(
    options.storageDriver ?? (process.env.STORAGE_DRIVER as "node-sqlite" | "better-sqlite3" | undefined) ?? "node-sqlite",
    sqlitePath,
    process.env.MARKET_HOT_PATH && process.env.MARKET_ARCHIVE_DIR
      ? { hotPath: process.env.MARKET_HOT_PATH, archiveDirectory: process.env.MARKET_ARCHIVE_DIR } : undefined,
  );
  await storage.open();
  await storage.migrate();
  // Account settings: encrypted overrides in the business database, environment variables as fallback.
  const secretBox = await createSecretBox({ keyFilePath: process.env.SETTINGS_KEY_FILE?.trim() || join(dirname(sqlitePath), "settings.key") });
  const settings = await createSettingsService({ storage, secretBox, readonly: loadBooleanEnvironment("SETTINGS_READONLY", false) });
  runtimeSettings = settings;
  log("settings.loaded", { encryption: secretBox.mode, readonly: settings.readonly });
  const configManager = new ConfigManager(configPath, 350, async (yamlConfig) => {
    const config = applyTradierEnvironment(applyEgressEnvironmentOverrides(yamlConfig), settings.env());
    await storage.syncConfigInstruments(config.instruments.map((instrument) => ({
      ...instrument,
      origin: "config" as const,
      shadowed: false,
    })), Date.now());
    await syncHeldInstruments(config, storage);
    const registry = new ConfigRegistry(config, await storage.getUserInstruments());
    return { config: applyTradierEnvironment(applyEgressEnvironmentOverrides(registry.appConfig()), settings.env()), issues: registry.issues };
  });
  const initialSnapshot = await configManager.loadInitial();
  const authMode = loadAuthMode();
  const authToken = await loadAuthToken(authMode);
  const secureSessionCookie = loadBooleanEnvironment("UI_AUTH_COOKIE_SECURE", false);
  const sessionTtlMs = loadSessionTtlMs();
  const sessions = new SessionStore(sessionTtlMs);
  const passwordAuth = authMode === "password"
    ? { credential: await ensurePasswordCredential(storage) }
    : null;
  await storage.saveConfigVersion({
    generation: initialSnapshot.generation,
    loadedAtMs: Date.parse(initialSnapshot.loadedAt),
    sha256: initialSnapshot.sha256,
    status: "active",
    diffJson: JSON.stringify({ initial: true }),
  });

  const pool = new EgressDispatcherPool(initialSnapshot.config.egressProfiles as Record<EgressName, EgressProfile>);
  const httpClient = new EgressHttpClient(pool, (event) => {
    log("egress.fallback", {
      level: "WARN",
      url: event.url,
      primary: event.primary,
      failedProfile: event.failedProfile,
      fallbackProfile: event.fallbackProfile,
      causeCode: event.error.code,
      message: event.error.message,
    });
  });
  // Readiness must not depend on external market/network availability.
  void runStartupClockSkewCheck(initialSnapshot, httpClient).catch(() => log("clock_skew.check_unavailable", {}));
  const adapters = createAdapterRegistry();
  let clockAuth: { base: string; token: string } | null = null;
  const refreshClock = async () => {
    const source = configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote"));
    if (!source) return;
    const token = await resolveAuthReference(source.authRef);
    if (token) { clockAuth = { base: source.baseUrl, token }; await refreshTradierClock(discoveryContext(source, httpClient, token)); }
  };
  // Regular-session hours from the cached Tradier calendar (early closes, holidays); weekday defaults until it is loaded.
  const sessionSchedule = (date: string) => clockAuth ? tradierCalendarDay(httpClient, clockAuth.base, clockAuth.token, date) : undefined;
  void refreshClock().catch(() => {});
  const marketClockTimer = setInterval(() => { void refreshClock().catch(() => {}); }, 60000);
  marketClockTimer.unref();
  const scheduler = new CollectorScheduler(storage, httpClient, adapters, resolveAuthReference, { onDemand: true, automaticStocks: true });
  await storage.recoverDailyInferenceRuns();
  const dailyHttp = new EgressHttpClient(new EgressDispatcherPool(dailyLlmEgressProfiles(initialSnapshot.config.egressProfiles as Record<EgressName, EgressProfile>)));
  const dailyLlm = switchableDailyLlmProvider(() => dailyLlmProvider(dailyHttp, settings.env()));
  const dailyInference = new DailyInferenceService(storage, dailyLlm, async id => {
    const source = configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks");
    const context = source ? discoveryContext(source, httpClient, await resolveAuthReference(source.authRef)) : null;
    const reply = await researchSeriesRequest(id, false, { storage, httpClient, tradierContext: context });
    return reply.body.series as import("@invest/domain").StudySeries | undefined ?? null;
  });
  scheduler.setBackgroundQuoteInstruments(await heldQuoteInstrumentIds(initialSnapshot.config, storage));
  const events = new SseEventHub();
  const intel = new IntelScheduler(storage, httpClient, resolveAuthReference, (item, generation) => {
    events.publish("news.created", generation, { news: item });
  });
  let eventQueue = Promise.resolve();
  const unsubscribeScheduler = scheduler.subscribe((event) => {
    eventQueue = eventQueue
      .then(() => publishSchedulerEvent(event, { configManager, storage, scheduler, events }))
      .catch((error) => log("sse.publish_failed", { error: errorMessage(error) }));
  });
  await scheduler.start(initialSnapshot);
  await intel.start(initialSnapshot);
  // Warm the risk-exposure beta cache once the collectors are running, so the overview's first read is not stuck behind history reads.
  const betaWarmTimer = setTimeout(() => { void riskExposureRuntime({ storage, configManager, httpClient }).then(warmRiskBetas).catch(error => log("risk.beta_warm_failed", { error: errorMessage(error) })); }, 15000);
  betaWarmTimer.unref();
  const performanceRecorder = createPerformanceRecorder({
    storage,
    sessionSchedule,
    // Session samples only re-read the live broker; IBKR Flex reports do not change intraday.
    refreshBrokers: kind => refreshPerformanceBrokers(brokerConnections(settings.env()).filter(c => kind === "half-day" || c.id === "tradier"), broker => refreshBrokerAccount(broker, { storage, configManager, httpClient, scheduler, events, settings })),
    record: async scheduledFor => {
      if (await enrichHeldMultipliers({ storage, configManager, httpClient })) await configManager.reload(true);
      scheduler.setBackgroundQuoteInstruments(await heldQuoteInstrumentIds(configManager.snapshot.config, storage));
      await syncAutomaticTradingCases(storage);
      await recordPerformance(storage, configManager.snapshot.config, scheduledFor);
    },
    onRecorded: () => events.publish("pnl.updated", configManager.snapshot.generation, { reason: "valuation-recorded" }),
  });
  let performanceClosing = false, performanceTimer: ReturnType<typeof setTimeout>;
  const checkPerformance = () => {
    if (performanceClosing) return;
    void performanceRecorder.runDue().catch(() => log("performance.record_failed", {}));
    // Align the next check with noon/midnight rather than server start time.
    const delay = Math.min(60000, Math.max(1, Date.parse(performanceSchedule(Date.now(), undefined, { sessionSchedule }).nextUpdateAt) - Date.now()));
    performanceTimer = setTimeout(checkPerformance, delay); performanceTimer.unref();
  };
  checkPerformance();
  const archiveTimer = setInterval(() => {
    void storage.maintainMarketHistory(2000).catch(error => log("market.archive_failed", { error: errorMessage(error) }));
  }, 60000);
  archiveTimer.unref();

  let brokerTask: Promise<void> | null = null, brokersClosing = false, lastCloseSyncDate: string | null = null;
  // Tradier only returns the current session's orders; read once more one minute before the regular close.
  const closeSyncPlan = async () => {
    const source = configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote"));
    const token = source ? await resolveAuthReference(source.authRef) : null;
    const plan = sessionCloseSyncPlan(Date.now(), date => source && token ? tradierCalendarDay(httpClient, source.baseUrl, token, date) : undefined);
    setCloseSyncStatus(storage, { nextSyncAt: plan?.syncAt ?? null, basis: plan?.basis ?? null, lastSyncedDate: lastCloseSyncDate, leadMinutes: CLOSE_SYNC_LEAD_MS / 60000 });
    return plan;
  };
  const refreshDueBrokers = () => {
    if (brokerTask || brokersClosing) return;
    brokerTask = (async () => {
      const [accounts, attempts] = await Promise.all([storage.getBrokerSnapshots(), storage.getBrokerSyncAttempts()]);
      const plan = await closeSyncPlan().catch(() => null);
      const connections = brokerConnections(settings.env());
      const closeSync = connections.some(c => c.id === "tradier" && c.configured) && closeSyncDue(Date.now(), plan, lastCloseSyncDate);
      if (closeSync && plan) { lastCloseSyncDate = plan.date; log("broker.close_sync", { date: plan.date, syncAt: plan.syncAt, basis: plan.basis }); }
      for (const connection of connections.filter(c => c.configured)) {
        if (brokersClosing) break;
        // Each provider's read-only cadence comes from the registry; the Tradier pre-close read ignores it.
        const interval = connection.id === "tradier" && closeSync ? 0 : (connection.cadenceMinutes ?? (connection.id === "tradier" ? 15 : 60)) * 60000;
        const environment = brokerSnapshotEnvironment(connection);
        const last = Math.max(0, ...accounts.filter(a => a.broker === connection.id && a.environment === environment).map(a => Date.parse(a.syncedAt) || 0), ...attempts.filter(a => a.broker === connection.id && a.mode === connection.mode).map(a => Date.parse(a.startedAt) || 0));
        if (Date.now() - last < interval || brokerSyncs.get(storage)?.has(connection.id)) continue;
        await refreshBrokerAccount(connection.id, { storage, configManager, httpClient, scheduler, events, settings }).catch(() => log("broker.auto_sync_failed", { broker: connection.id }));
      }
    })().catch(() => log("broker.auto_sync_failed", {})).finally(() => { brokerTask = null; });
  };
  const brokerTimer = setInterval(refreshDueBrokers, 60000); brokerTimer.unref();
  refreshDueBrokers();
  // Settings saved from the page/API apply live: Tradier environment re-derives the market config, the LLM
  // provider is rebuilt, and a newly configured broker syncs right away.
  const unsubscribeSettings = settings.subscribe(group => {
    log("settings.changed", { group });
    if (group === "llm") { dailyLlm.swap(); return; }
    if (group === "tradier") void configManager.reload(true).catch(() => undefined);
    if (group === "tradier" || group === "ibkr" || group === "schwab" || group === "alpaca") {
      const connection = brokerConnections(settings.env()).find(c => c.id === group);
      if (connection?.configured && !brokerSyncs.get(storage)?.has(group)) void refreshBrokerAccount(group, { storage, configManager, httpClient, scheduler, events, settings }).catch(() => log("broker.auto_sync_failed", { broker: group }));
    }
  });
  // Serve the built SPA from the API process when no reverse proxy is in front (source and bundle installs).
  const staticWeb = createStaticWeb({ directory: resolveWebDistDirectory(process.env, [process.env.WEB_DIST_DIR?.trim() ?? "", resolve("apps/web/dist")].filter(Boolean)) });
  log("web.static", { enabled: staticWeb.enabled });

  let previousSnapshot: ConfigSnapshot = initialSnapshot;
  const unsubscribe = configManager.subscribe((event) => {
    if (event.type === "invalid") {
      log("config.invalid", { issues: event.issues });
      return;
    }
    if (!event.snapshot || event.snapshot.generation === previousSnapshot.generation) return;
    const nextSnapshot = event.snapshot;
    const diff = configDiff(previousSnapshot.config, nextSnapshot.config);
    previousSnapshot = nextSnapshot;
    void (async () => {
      try {
        await httpClient.updateProfiles(nextSnapshot.config.egressProfiles as Record<EgressName, EgressProfile>);
        await dailyHttp.updateProfiles(dailyLlmEgressProfiles(nextSnapshot.config.egressProfiles as Record<EgressName, EgressProfile>));
        await storage.saveConfigVersion({
          generation: nextSnapshot.generation,
          loadedAtMs: Date.parse(nextSnapshot.loadedAt),
          sha256: nextSnapshot.sha256,
          status: "active",
          diffJson: JSON.stringify(diff),
        });
        scheduler.setBackgroundQuoteInstruments(await heldQuoteInstrumentIds(nextSnapshot.config, storage));
        await scheduler.applySnapshot(nextSnapshot);
        await intel.applySnapshot(nextSnapshot);
        events.publish("health.updated", nextSnapshot.generation, {
          reason: "config-reloaded",
          generation: nextSnapshot.generation,
        });
        log("config.loaded", { generation: nextSnapshot.generation });
      } catch (error) {
        log("config.apply_failed", { generation: nextSnapshot.generation, error: errorMessage(error) });
      }
    })();
  });
  configManager.startWatching();

  const server = createHttpServer({
    sessionSchedule,
    dailyInference,
    configManager,
    storage,
    scheduler,
    intel,
    httpClient,
    adapters,
    authMode,
    authToken,
    passwordAuth,
    loginRateLimiter: new LoginRateLimiter(),
    sessions,
    secureSessionCookie,
    events,
    settings,
    dailyLlm,
    staticWeb,
  });
  const host = options.host ?? process.env.API_BIND_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.API_PORT ?? 3000);
  await new Promise<void>((resolvePromise, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  return {
    configManager,
    storage,
    scheduler,
    intel,
    httpClient,
    adapters,
    server,
    port,
    events,
    async close() {
      unsubscribeSettings();
      if (runtimeSettings === settings) runtimeSettings = null;
      await dailyInference.close();
      await dailyHttp.close();
      brokersClosing = true; clearInterval(brokerTimer);
      await brokerTask;
      performanceClosing = true; clearTimeout(performanceTimer);
      await performanceRecorder.close();
      clearInterval(archiveTimer);
      clearInterval(marketClockTimer);
      unsubscribe();
      unsubscribeScheduler();
      configManager.stopWatching();
      await intel.stop();
      await scheduler.stop();
      await eventQueue;
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
      events.close();
      await httpClient.close();
      await storage.close();
    },
  };
}

function createHttpServer(deps: HttpDependencies): Server {
  return createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      if (deps.staticWeb?.enabled && !path.startsWith("/api/") && !path.startsWith("/health/") && await deps.staticWeb.handle(request, response)) return;
      await handleRequest(request, response, deps);
    })().catch((error) => {
      log("http.unhandled_error", { error: errorMessage(error) });
      writeJson(response, 500, { error: "internal_error", message: errorMessage(error) });
    });
  });
}

export async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HttpDependencies,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;
  log("http.request", { method: request.method, path: pathname });

  if (request.method === "POST" && pathname === "/api/session") {
    await createSession(request, response, deps);
    return;
  }
  if ((request.method === "POST" && pathname === "/api/session/logout")
    || (request.method === "DELETE" && pathname === "/api/session")) {
    revokeSession(request, response, deps);
    return;
  }
  if (request.method === "GET" && pathname === "/api/session") {
    if (!authEnabled(deps) || requestAuthorized(request, deps)) {
      writeJson(response, 200, {
        authenticated: true,
        usingInitialPassword: deps.passwordAuth?.credential.isInitial ?? false,
      });
    } else {
      writeUnauthorized(response);
    }
    return;
  }

  if (pathname.startsWith("/api/") && authEnabled(deps) && !requestAuthorized(request, deps)) {
    writeUnauthorized(response);
    return;
  }

  // Every state-changing API method needs the custom header (or a Bearer token) so a new route can never be
  // added without CSRF protection. Session login/logout are handled above.
  const isStateChangingApiRequest = pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method ?? "GET");
  if (isStateChangingApiRequest && !bearerAuthorized(request, deps) && !hasRequestedWithHeader(request)) {
    writeJson(response, 403, { error: "csrf_required" });
    return;
  }

  if (request.method === "GET" && (pathname === "/api/events" || pathname === "/api/sse")) {
    handleSse(request, response, deps.events);
    return;
  }

  if (request.method === "POST" && pathname === "/api/market/interest") {
    const body = await readJson(request);
    const id = body.instrumentId;
    if (typeof body.clientId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(body.clientId)
      || (id !== null && (typeof id !== "string" || !deps.configManager.snapshot.config.instruments.some(i => i.id === id && i.active && i.watch)))) {
      writeJson(response, 400, { error: "invalid_market_interest" }); return;
    }
    deps.scheduler.setInterest(body.clientId, id as string | null);
    writeJson(response, 200, { accepted: true }); return;
  }

  if (request.method === "GET" && pathname === "/health/live") {
    writeJson(response, 200, { status: "ok" });
    return;
  }
  if (request.method === "GET" && pathname === "/health/ready") {
    const schedulerStatus = deps.scheduler.status();
    const heartbeatAge = schedulerStatus.lastHeartbeat ? Date.now() - Date.parse(schedulerStatus.lastHeartbeat) : Infinity;
    const ready = schedulerStatus.state === "running" && heartbeatAge < 120_000 && await deps.storage.ping();
    const intelStatus = await deps.intel.status();
    writeJson(response, ready ? 200 : 503, {
      status: ready ? "ready" : "not_ready",
      scheduler: schedulerStatus.state,
      collection: { configured: schedulerStatus.jobs, active: schedulerStatus.activeJobs, paused: schedulerStatus.pausedJobs },
      generation: schedulerStatus.generation,
      lastHeartbeat: schedulerStatus.lastHeartbeat,
      storage: await deps.storage.ping(),
      intel: intelStatus.state,
    });
    return;
  }

  if (request.method === "GET" && pathname === "/api/config") {
    const snapshot = deps.configManager.snapshot;
    writeJson(response, 200, safeConfig(snapshot, deps.scheduler, deps.intel));
    return;
  }
  if (request.method === "GET" && pathname === "/api/snapshot") {
    const snapshot = deps.configManager.snapshot;
    const observations = await quoteObservations(deps.storage);
    const [view, positions, transactions, news, egress, instruments] = await Promise.all([
      buildViewDescriptor(snapshot, deps, observations), positionViews(snapshot, deps, observations),
      deps.storage.getTransactions(), deps.storage.getNews(undefined, 200, false), sourceEgressStatuses(snapshot, deps.storage),
      Promise.all(snapshot.config.instruments.filter(i => i.active).map(async instrument => ({ ...instrument,
        origin: instrument.metadata.origin === "user" ? "user" : "config", quotes: await quoteEnvelopes(instrument, snapshot, deps, observations) }))),
    ]);
    writeJson(response, 200, { generation: snapshot.generation, view: { ...view, generation: snapshot.generation }, positions,
      transactions, news, egress, health: observations.health, quotes: instruments.flatMap(i => i.quotes),
      instruments: Object.fromEntries(instruments.map(i => [i.id, i])), pnlSummary: pnlSummaryResponse(snapshot, positions, transactions) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/password") {
    await changePassword(request, response, deps);
    return;
  }
  if (request.method === "GET" && (pathname === "/api/view" || pathname === "/api/descriptors")) {
    const snapshot = deps.configManager.snapshot;
    writeJson(response, 200, {
      ...await buildViewDescriptor(snapshot, deps),
      generation: snapshot.generation,
    });
    return;
  }
  if (request.method === "POST" && pathname === "/api/config/reload") {
    const event = await deps.configManager.reload(true);
    writeJson(response, event.type === "loaded" ? 200 : 422, event);
    return;
  }
  if (request.method === "GET" && pathname === "/api/instruments/search") {
    await searchInstruments(requestUrl, response, deps);
    return;
  }
  if (request.method === "POST" && pathname === "/api/instruments/probe") {
    await probeInstruments(request, response, deps);
    return;
  }
  if (request.method === "POST" && pathname === "/api/instruments") {
    await createUserInstrument(request, response, deps);
    return;
  }
  if (request.method === "PATCH" && pathname.startsWith("/api/instruments/")) {
    const instrumentId = instrumentIdFromPath(pathname);
    if (instrumentId === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    await patchUserInstrument(request, response, instrumentId, deps);
    return;
  }
  if (request.method === "DELETE" && pathname.startsWith("/api/instruments/")) {
    const instrumentId = instrumentIdFromPath(pathname);
    if (instrumentId === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    await deleteUserInstrument(response, instrumentId, requestUrl.searchParams.get("hard") === "true", deps);
    return;
  }
  if (request.method === "GET" && pathname === "/api/instruments") {
    const snapshot = deps.configManager.snapshot;
    const observations = await quoteObservations(deps.storage);
    const instruments = await Promise.all(snapshot.config.instruments.filter((instrument) => instrument.active).map(async (instrument) => ({
      ...instrument,
      origin: instrument.metadata.origin === "user" ? "user" : "config",
      quotes: await quoteEnvelopes(instrument, snapshot, deps, observations),
    })));
    writeJson(response, 200, { generation: snapshot.generation, instruments });
    return;
  }
  if (pathname === "/api/trading-review" || pathname.startsWith("/api/trading-review/")) {
    const result = await tradingReviewRequest(request.method ?? "GET", pathname, request.method === "POST" ? await readJson(request) : undefined, deps.storage);
    writeJson(response, result.status, result.body);
    return;
  }
  if ((request.method === "GET" && pathname === "/api/research/market/series") || (request.method === "POST" && pathname === "/api/research/market/refresh")) {
    const source = deps.configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks");
    const context = source ? discoveryContext(source, deps.httpClient, await resolveAuthReference(source.authRef)) : null;
    const body = request.method === "POST" ? await readJson(request) : null;
    const id = body ? typeof body.id === "string" ? body.id : "" : requestUrl.searchParams.get("id") ?? "";
    const result = await researchSeriesRequest(id, request.method === "POST", { storage: deps.storage, httpClient: deps.httpClient, tradierContext: context });
    writeJson(response, result.status, result.body); return;
  }
  if (pathname === "/api/research/market/catalog" || pathname === "/api/research/board" || pathname.startsWith("/api/research/board/")) {
    const result = await researchBoardRequest(request.method ?? "GET", pathname, ["POST", "PATCH"].includes(request.method ?? "") ? await readJson(request) : undefined, deps.storage);
    writeJson(response, result.status, result.body); return;
  }
  if (pathname === "/api/research/daily-inference" || pathname.startsWith("/api/research/daily-inference/")) {
    if (!deps.dailyInference) { writeJson(response, 503, { message: "日报推理服务尚未初始化。" }); return; }
    const result = await deps.dailyInference.request(request.method ?? "GET", requestUrl, ["POST", "PATCH"].includes(request.method ?? "") ? await readJson(request) : undefined);
    writeJson(response, result.status, result.body); return;
  }
  if (pathname === "/api/research/daily-reports" || pathname.startsWith("/api/research/daily-reports/")) {
    const result = await marketDailyRequest(request.method ?? "GET", requestUrl, ["POST", "PATCH"].includes(request.method ?? "") ? await readJson(request) : undefined, deps.storage);
    writeJson(response, result.status, result.body); return;
  }
  if (request.method === "GET" && pathname === "/api/research") {
    writeJson(response, 200, { entries: await deps.storage.getResearchEntries() });
    return;
  }
  if (request.method === "POST" && pathname === "/api/research") {
    const parsed = ResearchWriteSchema.safeParse(await readJson(request));
    if (!parsed.success) { writeJson(response, 400, { message: parsed.error.issues.map(issue => issue.message).join("；") }); return; }
    const [news, manual, brokers] = await Promise.all([deps.storage.getNews(undefined, 1000), deps.storage.getTransactions(), deps.storage.getBrokerSnapshots()]);
    const newsById = new Map(news.map(item => [item.id, item]));
    const tradeLabels = new Map(manual.map(trade => [trade.id, `${trade.instrumentId} · ${trade.type} · ${trade.quantity} · ${new Date(trade.tradeAtMs).toISOString()}`]));
    for (const account of brokers) for (const trade of account.trades) tradeLabels.set(trade.id, `${account.broker} · ${trade.symbol} · ${trade.side} · ${trade.quantity} · ${trade.tradedAt}`);
    if (parsed.data.newsIds.some(id => !newsById.has(id)) || parsed.data.transactionIds.some(id => !tradeLabels.has(id))) {
      writeJson(response, 400, { message: "关联的新闻或交易已不可用，请刷新后重新选择" }); return;
    }
    const entry: ResearchEntry = { ...parsed.data, id: randomUUID(), createdAt: new Date().toISOString(), reviews: [],
      evidence: [...new Set(parsed.data.newsIds)].map(id => { const item = newsById.get(id)!; return { id, title: item.title, url: item.url }; }),
      linkedTrades: [...new Set(parsed.data.transactionIds)].map(id => ({ id, label: tradeLabels.get(id)! })),
    };
    await deps.storage.createResearchEntry(entry);
    writeJson(response, 201, { entry });
    return;
  }
  if (request.method === "POST" && /^\/api\/research\/[^/]+\/reviews$/.test(pathname)) {
    const parsed = ResearchReviewSchema.safeParse(await readJson(request));
    if (!parsed.success) { writeJson(response, 400, { message: "请选择验证结论并填写复盘依据" }); return; }
    const id = decodeURIComponent(pathname.split("/")[3]!);
    const entry = await deps.storage.appendResearchReview(id, parsed.data, new Date().toISOString());
    writeJson(response, entry ? 200 : 404, entry ? { entry } : { message: "记录不存在" });
    return;
  }
  if (request.method === "GET" && pathname === "/api/brokers") {
    writeJson(response, 200, await brokerWorkspaceData(deps.storage, deps.configManager?.snapshot.config, deps.settings?.env()));
    return;
  }
  if (pathname === "/api/settings" || pathname.startsWith("/api/settings/")) {
    if (!deps.settings) { writeJson(response, 503, { message: "设置服务未初始化" }); return; }
    const body = ["PUT", "POST"].includes(request.method ?? "") ? await readJson(request).catch(() => ({})) : undefined;
    const reply = await settingsRequest(request.method ?? "GET", requestUrl, body, {
      settings: deps.settings,
      publicOrigin: process.env.UI_PUBLIC_URL?.trim() || `http://${request.headers.host ?? "localhost:8080"}`,
      statuses: () => settingsStatuses(deps),
      test: (group, env) => settingsTest(group, env, deps),
      schwab: { authorizeUrl: env => schwabAuthorizeUrl(env), exchange: (env, code) => schwabExchangeCode(env, code) },
    });
    writeJson(response, reply.status, reply.body);
    return;
  }
  if (request.method === "GET" && (pathname === "/api/risk-exposure" || pathname === "/api/risk-exposure/reference")) {
    // Read-only: broker snapshots + live Tradier quotes (option Greeks) + betas from stored candles / Tradier history.
    const numberParam = (name: string) => { const value = Number(requestUrl.searchParams.get(name) ?? ""); return Number.isFinite(value) && value > 0 ? value : undefined; };
    const ratio = numberParam("ratio"), putDelta = numberParam("putDelta");
    const result = await riskExposureData({ ...await riskExposureRuntime(deps), options: { ...(ratio !== undefined ? { ratio } : {}), ...(putDelta !== undefined ? { putDelta } : {}) } });
    writeJson(response, 200, pathname.endsWith("/reference") ? riskExposureReference(result) : result);
    return;
  }
  if (request.method === "GET" && pathname === "/api/performance") {
    const [current, history] = await Promise.all([currentPerformance(deps.storage, deps.configManager.snapshot.config), deps.storage.getPerformanceHistory()]);
    // history=0 lets the page skip the raw sample list; the aggregated daily candles are always returned.
    const includeHistory = requestUrl.searchParams.get("history") !== "0";
    writeJson(response, 200, { current, ...(includeHistory ? { history } : {}), daily: dailyPerformanceCandles(history, PERFORMANCE_CANDLE_TIME_ZONE), schedule: performanceSchedule(Date.now(), undefined, { sessionSchedule: deps.sessionSchedule }) }); return;
  }
  if (request.method === "POST" && /^\/api\/brokers\/(tradier|ibkr|schwab|alpaca)\/sync$/.test(pathname)) {
    const broker = pathname.split("/")[3] as BrokerApiId;
    if (brokerSyncs.get(deps.storage)?.has(broker)) { writeJson(response, 409, { message: "该券商正在同步，请稍候" }); return; }
    try {
      await refreshBrokerAccount(broker, deps);
      const workspace = await brokerWorkspaceData(deps.storage, deps.configManager?.snapshot.config, deps.settings?.env());
      writeJson(response, 200, { accounts: workspace.accounts.filter(a => a.broker === broker), connection: workspace.connections.find(c => c.id === broker) });
    } catch (error) { writeJson(response, 502, { message: error instanceof Error ? error.message : "券商同步失败" }); }
    return;
  }
  if (request.method === "GET" && pathname === "/api/positions") {
    const positions = await positionViews(deps.configManager.snapshot, deps);
    writeJson(response, 200, { positions });
    return;
  }
  if (request.method === "GET" && pathname === "/api/transactions") {
    const query = transactionQuery(requestUrl);
    if (!query.ok) {
      writeJson(response, 400, { error: "invalid_transaction_range", message: query.message });
      return;
    }
    writeJson(response, 200, { transactions: await deps.storage.getTransactions(query.value) });
    return;
  }
  if (request.method === "POST" && pathname === "/api/transactions") {
    await createManualTransaction(request, response, deps);
    return;
  }
  if (request.method === "PATCH" && pathname.startsWith("/api/transactions/")) {
    const transactionId = resourceIdFromPath(pathname, "/api/transactions/");
    if (transactionId === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    await patchManualTransaction(request, response, transactionId, deps);
    return;
  }
  if (request.method === "DELETE" && pathname.startsWith("/api/transactions/")) {
    const transactionId = resourceIdFromPath(pathname, "/api/transactions/");
    if (transactionId === null) {
      writeJson(response, 404, { error: "not_found" });
      return;
    }
    const deleted = await deps.storage.deleteTransaction(transactionId);
    writeJson(response, deleted ? 200 : 404, deleted
      ? { status: "deleted", id: transactionId }
      : { error: "transaction_not_found", id: transactionId });
    return;
  }
  if (request.method === "GET" && pathname === "/api/pnl/summary") {
    const snapshot = deps.configManager.snapshot;
    const [positions, transactions] = await Promise.all([
      positionViews(snapshot, deps),
      deps.storage.getTransactions(),
    ]);
    writeJson(response, 200, pnlSummaryResponse(snapshot, positions, transactions));
    return;
  }
  if (request.method === "GET" && pathname === "/api/news") {
    const instrumentId = requestUrl.searchParams.get("instrumentId") ?? undefined;
    const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 100);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.trunc(requestedLimit))) : 100;
    const news = await deps.storage.getNews(instrumentId, limit, false);
    writeJson(response, 200, { generation: deps.configManager.snapshot.generation, news });
    return;
  }
  if (request.method === "GET" && pathname === "/api/news/provenance") {
    const newsId = requestUrl.searchParams.get("newsId");
    if (!newsId) {
      writeJson(response, 400, { error: "newsId_required" });
      return;
    }
    writeJson(response, 200, { newsId, provenance: await deps.storage.getNewsProvenance(newsId) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/intel/status") {
    writeJson(response, 200, await deps.intel.status());
    return;
  }
  if (request.method === "GET" && pathname === "/api/llm/models") {
    const providerId = requestUrl.searchParams.get("providerId");
    if (!providerId) {
      writeJson(response, 400, { error: "providerId_required" });
      return;
    }
    const result = await deps.intel.listModels(providerId);
    writeJson(response, result.ok ? 200 : 502, result.ok ? { providerId, models: result.value } : { providerId, error: result.error });
    return;
  }
  if (request.method === "POST" && pathname === "/api/intel/collect") {
    const body = await readJson(request);
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
    writeJson(response, 200, { results: await deps.intel.collectNow(sourceId) });
    return;
  }
  if (request.method === "GET" && pathname.startsWith("/api/instruments/") && pathname.endsWith("/quotes")) {
    const instrumentId = decodeURIComponent(pathname.slice("/api/instruments/".length, -"/quotes".length));
    await writeInstrumentQuotes(response, instrumentId, deps);
    return;
  }
  if (request.method === "GET" && ["/api/market/quotes", "/api/market/history", "/api/market/timesales", "/api/options/expirations", "/api/options"].includes(pathname)) {
    const source = deps.configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote") && s.defaultBinding);
    if (!source) { writeJson(response, 503, { message: "Tradier 行情数据源尚未启用。" }); return; }
    const context = discoveryContext(source, deps.httpClient, await resolveAuthReference(source.authRef));
    const result = await tradierMarketData(requestUrl, { ...context, capability: pathname.startsWith("/api/options") ? "optionChain" : "quote" });
    writeJson(response, result.status, result.body);
    return;
  }
  if (request.method === "GET" && pathname === "/api/quotes") {
    const instrumentId = requestUrl.searchParams.get("instrumentId") ?? undefined;
    const sourceId = requestUrl.searchParams.get("sourceId") ?? undefined;
    const snapshot = deps.configManager.snapshot;
    const instruments = snapshot.config.instruments.filter((instrument) => instrument.active && (!instrumentId || instrument.id === instrumentId));
    if (instrumentId && instruments.length === 0) {
      writeJson(response, 404, { error: "instrument_not_configured", instrumentId });
      return;
    }
    const observations = await quoteObservations(deps.storage);
    const values = (await Promise.all(instruments.map((instrument) => quoteEnvelopes(instrument, snapshot, deps, observations))))
      .flat()
      .filter((entry) => !sourceId || entry.sourceId === sourceId);
    writeJson(response, 200, { generation: snapshot.generation, quotes: values });
    return;
  }
  if (request.method === "GET" && pathname === "/api/quotes/history") {
    const instrumentId = requestUrl.searchParams.get("instrumentId");
    if (!instrumentId) {
      writeJson(response, 400, { error: "instrumentId_required" });
      return;
    }
    const sourceId = requestUrl.searchParams.get("sourceId") ?? undefined;
    const limit = Math.min(1000, Math.max(1, Number(requestUrl.searchParams.get("limit") ?? 200)));
    const range = historyRange(requestUrl);
    if (!range) { writeJson(response, 400, { error: "invalid_history_range" }); return; }
    const rows = await deps.storage.getQuoteHistory(instrumentId, sourceId, Number.isFinite(limit) ? limit : 200, range.before, range.from);
    writeJson(response, 200, { instrumentId, history: rows, nextBefore: rows.at(-1)?.capturedAtMs ?? null });
    return;
  }
  if (request.method === "GET" && pathname === "/api/candles") {
    const instrumentId = requestUrl.searchParams.get("instrumentId");
    if (!instrumentId) {
      writeJson(response, 400, { error: "instrumentId_required" });
      return;
    }
    const sourceId = requestUrl.searchParams.get("sourceId") ?? undefined;
    const timeframe = requestUrl.searchParams.get("timeframe") ?? "1m";
    const limit = Math.min(1000, Math.max(1, Number(requestUrl.searchParams.get("limit") ?? 200)));
    const range = historyRange(requestUrl);
    if (!range) { writeJson(response, 400, { error: "invalid_history_range" }); return; }
    const chart = requestUrl.searchParams.get("indicators") === "ma";
    const chartLimit = Number.isFinite(limit) ? Math.floor(limit) : 200;
    const rows = await deps.storage.getCandles(instrumentId, sourceId, timeframe, chart ? Math.min(1000, chartLimit + 199) : chartLimit, range.before, chart ? undefined : range.from);
    const snapshot = deps.configManager.snapshot;
    const instrument = snapshot.config.instruments.find((candidate) => candidate.id === instrumentId);
    if (!instrument) {
      writeJson(response, 404, { error: "instrument_not_configured", instrumentId });
      return;
    }
    const candles = rows.map((row) => {
      const binding = instrument.sourceBindings.find((candidate) => candidate.sourceId === row.sourceId);
      const freshness = computeFreshness(
        new Date(row.capturedAtMs).toISOString(),
        new Date(row.receivedAtMs).toISOString(),
        binding?.staleAfterSeconds ?? 300,
        new Date(),
        deps.scheduler.sourceFreshnessClass(row.sourceId),
        deps.configManager.snapshot.config.clockSkewToleranceMs,
      );
      return CandleSchema.parse({
        instrumentId: row.instrumentId,
        sourceId: row.sourceId,
        timeframe: row.timeframe,
        openTime: new Date(row.openTimeMs).toISOString(),
        closeTime: new Date(row.closeTimeMs).toISOString(),
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume,
        tradeCount: row.tradeCount,
        session: row.session,
        quoteAsset: row.quoteAsset,
        convertedTo: parseJsonOrNull(row.convertedToJson),
        freshness,
      });
    });
    writeJson(response, 200, { instrumentId, candles: chart ? candleChartWindow(candles, chartLimit).filter(c => Date.parse(c.openTime) >= range.from) : candles, warnings: await deps.storage.getCandleWarnings(instrumentId, sourceId) });
    return;
  }
  if (request.method === "GET" && pathname === "/api/source-health") {
    const snapshot = deps.configManager.snapshot;
    const [health, egress] = await Promise.all([
      deps.storage.getLatestSourceHealth(),
      sourceEgressStatuses(snapshot, deps.storage),
    ]);
    writeJson(response, 200, {
      clockSkewToleranceMs: snapshot.config.clockSkewToleranceMs,
      health,
      egress,
    });
    return;
  }
  if (request.method === "GET" && pathname === "/api/egress/self-check") {
    writeJson(response, 200, await runEgressChecks(deps));
    return;
  }
  if (request.method === "GET" && pathname.startsWith("/api/egress/probe/")) {
    const profile = pathname.slice("/api/egress/probe/".length);
    if (profile !== "direct" && profile !== "corp" && profile !== "vpn") {
      writeJson(response, 400, { error: "invalid_egress_profile" });
      return;
    }
    const checks = await runEgressChecks(deps);
    const selected = checks.profiles.find((entry) => entry.profile === profile);
    writeJson(response, selected?.ok ? 200 : 502, selected ?? { profile, ok: false });
    return;
  }
  if (request.method === "POST" && pathname === "/api/collect") {
    const body = await readJson(request);
    const instrumentId = typeof body.instrumentId === "string" ? body.instrumentId : undefined;
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : undefined;
    const result = await deps.scheduler.collectNow(instrumentId, sourceId);
    writeJson(response, 200, { results: result });
    return;
  }

  writeJson(response, 404, { error: "not_found" });
}

interface PositionView extends StoredPositionProjection {
  readonly markPrice: string | null;
  readonly marketValue: string | null;
  readonly unrealizedPnl: string | null;
  readonly markQuoteAsset: string | null;
  readonly markSourceId: string | null;
  readonly freshness: Freshness;
}

async function createManualTransaction(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HttpDependencies,
): Promise<void> {
  const body = await readJson(request);
  const parsed = TransactionWriteSchema.safeParse({ ...body, accountId: "manual" });
  if (!parsed.success) {
    writeJson(response, 400, { error: "invalid_transaction", message: parsed.error.message });
    return;
  }
  if (!transactionInstrumentAvailable(parsed.data.instrumentId, deps.configManager.snapshot)) {
    writeJson(response, 400, { error: "instrument_not_available", message: "只能为已添加且启用的标的录入交易" });
    return;
  }
  try {
    const transaction = await deps.storage.createTransaction(randomUUID(), parsed.data);
    writeJson(response, 201, { transaction });
  } catch (error) {
    writeTransactionError(response, error);
  }
}

async function patchManualTransaction(
  request: IncomingMessage,
  response: ServerResponse,
  transactionId: string,
  deps: HttpDependencies,
): Promise<void> {
  const body = await readJson(request);
  const parsed = TransactionPatchSchema.safeParse(body);
  if (!parsed.success || (parsed.success && parsed.data.accountId !== undefined && parsed.data.accountId !== "manual")) {
    writeJson(response, 400, {
      error: "invalid_transaction_patch",
      message: parsed.success ? "manual transactions must remain in the manual account" : parsed.error.message,
    });
    return;
  }
  if (parsed.data.instrumentId !== undefined
    && !transactionInstrumentAvailable(parsed.data.instrumentId, deps.configManager.snapshot)) {
    writeJson(response, 400, { error: "instrument_not_available", message: "只能为已添加且启用的标的录入交易" });
    return;
  }
  try {
    const transaction = await deps.storage.updateTransaction(transactionId, parsed.data);
    writeJson(response, transaction ? 200 : 404, transaction
      ? { transaction }
      : { error: "transaction_not_found", id: transactionId });
  } catch (error) {
    writeTransactionError(response, error);
  }
}

function writeTransactionError(response: ServerResponse, error: unknown): void {
  const message = errorMessage(error);
  if (message.includes("mixed transaction currencies")) {
    writeJson(response, 409, { error: "mixed_transaction_currencies", message });
    return;
  }
  if (message.includes("validation") || message.includes("must be") || message.includes("requires a price")) {
    writeJson(response, 400, { error: "invalid_transaction", message });
    return;
  }
  throw error;
}

function transactionInstrumentAvailable(instrumentId: string, snapshot: ConfigSnapshot): boolean {
  return snapshot.config.instruments.some((instrument) => instrument.id === instrumentId && instrument.active);
}

function transactionQuery(requestUrl: URL):
  | { readonly ok: true; readonly value: { instrumentId?: string; fromMs?: number; toMs?: number } }
  | { readonly ok: false; readonly message: string } {
  const instrumentId = requestUrl.searchParams.get("instrumentId")?.trim() || undefined;
  const from = integerQueryValue(requestUrl.searchParams.get("from"));
  const to = integerQueryValue(requestUrl.searchParams.get("to"));
  if (from === "invalid" || to === "invalid") {
    return { ok: false, message: "from and to must be non-negative epoch milliseconds" };
  }
  if (from !== undefined && to !== undefined && from > to) {
    return { ok: false, message: "from must be less than or equal to to" };
  }
  return {
    ok: true,
    value: {
      ...(instrumentId ? { instrumentId } : {}),
      ...(from === undefined ? {} : { fromMs: from }),
      ...(to === undefined ? {} : { toMs: to }),
    },
  };
}

function integerQueryValue(value: string | null): number | undefined | "invalid" {
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) return "invalid";
  const parsed = +value;
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

function resourceIdFromPath(pathname: string, prefix: string): string | null {
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

async function positionViews(
  snapshot: ConfigSnapshot,
  deps: Pick<HttpDependencies, "storage" | "scheduler">,
  observations?: QuoteObservations,
): Promise<PositionView[]> {
  const projections = await deps.storage.getPositionProjections();
  return Promise.all(projections.map(async (projection) => {
    const instrument = snapshot.config.instruments.find((candidate) => candidate.id === projection.instrumentId);
    const quoteRows = instrument ? await quoteEnvelopes(instrument, snapshot, deps, observations) : [];
    const ordered = [...quoteRows].sort((left, right) => left.priority - right.priority);
    const usable = ordered.find((entry) =>
      entry.freshness.status !== "unavailable" && entry.quote?.price !== null && entry.quote?.price !== undefined);
    const selected = usable ?? ordered[0];
    const freshness = selected?.freshness
      ?? unavailableFreshness(instrument?.sourceBindings[0]?.staleAfterSeconds ?? 300, snapshot.config.clockSkewToleranceMs);
    const markPrice = usable?.quote?.price ?? null;
    const markQuoteAsset = selected?.quoteAsset ?? instrument?.quoteAsset ?? projection.quoteAsset;
    const valuation = valuePosition({
      ...projection,
      markPrice,
      markQuoteAsset,
    });
    const position = PositionSchema.parse({
      id: projection.id,
      accountId: projection.accountId,
      instrumentId: projection.instrumentId,
      quantity: projection.quantity,
      averageCost: projection.averageCost,
      costBasis: projection.costBasis,
      markPrice,
      marketValue: valuation.marketValue,
      realizedPnl: projection.realizedPnl,
      unrealizedPnl: valuation.unrealizedPnl,
      quoteAsset: projection.quoteAsset,
      asOf: new Date(projection.asOfMs).toISOString(),
      freshness: markPrice === null
        ? { ...freshness, status: "unavailable" as const, isStale: true }
        : freshness,
    });
    return {
      ...projection,
      ...position,
      freshnessStatus: position.freshness.status,
      markQuoteAsset,
      markSourceId: selected?.sourceId ?? null,
    };
  }));
}

function pnlSummaryResponse(
  snapshot: ConfigSnapshot,
  positions: readonly PositionView[],
  transactions: readonly StoredTransaction[],
) {
  const valuationInputs = positions.map(positionValuationInput);
  const summary = summarizePortfolio(valuationInputs, transactions);
  const sectionSummaries = Object.fromEntries(snapshot.config.sections
    .filter((section) => section.id !== "other")
    .map((section) => {
      const instrumentIds = new Set(snapshot.config.instruments
        .filter((instrument) => instrumentMatchesSection(instrument, section))
        .map((instrument) => instrument.id));
      return [section.id, summarizePortfolio(
        valuationInputs.filter((position) => instrumentIds.has(position.instrumentId)),
        transactions.filter((transaction) => instrumentIds.has(transaction.instrumentId)),
        valuationInputs,
      )];
    }));
  return { ...summary, sectionSummaries };
}

function positionValuationInput(position: PositionView): PositionValuationInput {
  return {
    accountId: position.accountId,
    instrumentId: position.instrumentId,
    quantity: position.quantity,
    averageCost: position.averageCost,
    costBasis: position.costBasis,
    realizedPnl: position.realizedPnl,
    quoteAsset: position.quoteAsset,
    asOfMs: position.asOfMs,
    markPrice: position.markPrice,
    markQuoteAsset: position.markQuoteAsset,
  };
}

interface InstrumentProbeEvidence {
  readonly candidate: InstrumentCandidate;
  readonly ok: boolean;
  readonly price: string | null;
  readonly quoteAsset: string | null;
  readonly capturedAt: string | null;
  readonly freshness: Freshness | null;
  readonly egressUsed: EgressName | null;
  readonly latencyMs: number;
  readonly error: unknown | null;
}

async function searchInstruments(
  requestUrl: URL,
  response: ServerResponse,
  deps: HttpDependencies,
): Promise<void> {
  const query = (requestUrl.searchParams.get("q") ?? "").trim();
  if (!query) {
    writeJson(response, 400, { error: "query_required", message: "q must not be empty" });
    return;
  }
  if (query.length > 100) {
    writeJson(response, 400, { error: "query_too_long" });
    return;
  }
  const snapshot = deps.configManager.snapshot;
  const searchableSources = snapshot.config.sources
    .map((source, sourceOrder) => ({ source, sourceOrder }))
    .filter(({ source }) => source.capabilities.includes("instrumentSearch"));
  const sourceResults = await Promise.all(searchableSources.map(async ({ source, sourceOrder }) => {
    try {
      const authToken = await resolveAuthReference(source.authRef).catch(() => null);
      const unavailable = discoveryUnavailableReason(source, authToken, deps.adapters);
      if (unavailable) {
        return { sourceId: source.id, sourceOrder, enabled: source.enabled, available: false as const, unavailableReason: unavailable, candidates: [] };
      }
      const adapter = deps.adapters.get(source.adapter);
      if (!adapter?.searchInstruments || !source.defaultBinding) {
        return {
          sourceId: source.id,
          sourceOrder,
          enabled: source.enabled,
          available: false as const,
          unavailableReason: { code: "search-unsupported", message: "该数据源未实现标的搜索", steps: [] },
          candidates: [],
        };
      }
      const result = await adapter.searchInstruments(query, discoveryContext(source, deps.httpClient, authToken));
      if (!result.ok) {
        return {
          sourceId: source.id,
          sourceOrder,
          enabled: source.enabled,
          available: false as const,
          unavailableReason: {
            code: result.error.code ?? result.error.causeCode ?? "search-failed",
            message: result.error.message,
            steps: result.error.code === "auth-missing" ? sourceEnablementSteps(source) : [],
          },
          candidates: [],
        };
      }
      return {
        sourceId: source.id,
        sourceOrder,
        enabled: source.enabled,
        available: true as const,
        unavailableReason: null,
        candidates: result.value,
      };
    } catch (error) {
      return {
        sourceId: source.id,
        sourceOrder,
        enabled: source.enabled,
        available: false as const,
        unavailableReason: {
          code: "search-failed",
          message: errorMessage(error),
          steps: [],
        },
        candidates: [],
      };
    }
  }));
  const orderBySource = new Map(sourceResults.map((result) => [result.sourceId, result.sourceOrder]));
  const candidates = sourceResults.flatMap((result) => result.candidates).sort((left, right) =>
    instrumentSearchMatchLevel(left, query) - instrumentSearchMatchLevel(right, query)
    || (orderBySource.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) - (orderBySource.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER)
    || rankForSort(left.rank) - rankForSort(right.rank));
  const grouped = new Map<string, InstrumentCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.baseAsset.toUpperCase();
    const entries = grouped.get(key) ?? [];
    entries.push(candidate);
    grouped.set(key, entries);
  }
  writeJson(response, 200, {
    query,
    generation: snapshot.generation,
    candidates,
    groups: [...grouped.entries()].map(([baseAsset, entries]) => ({ baseAsset, candidates: entries })),
    sources: sourceResults.map(({ sourceOrder: _sourceOrder, ...result }) => result),
  });
}

async function probeInstruments(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HttpDependencies,
): Promise<void> {
  const body = await readJson(request);
  const parsed = parseCandidateList(body.candidates);
  if (!parsed.ok) {
    writeJson(response, 400, { error: "invalid_candidates", message: parsed.message });
    return;
  }
  const probes = await Promise.all(parsed.candidates.map((candidate) => probeInstrumentCandidate(candidate, deps)));
  writeJson(response, 200, { generation: deps.configManager.snapshot.generation, probes });
}

async function createUserInstrument(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HttpDependencies,
): Promise<void> {
  const body = await readJson(request);
  const parsed = parseCandidateList(body.candidates);
  if (!parsed.ok) {
    writeJson(response, 400, { error: "invalid_candidates", message: parsed.message });
    return;
  }
  const [firstCandidate] = parsed.candidates;
  if (!firstCandidate || parsed.candidates.some((candidate) =>
    candidate.baseAsset !== firstCandidate.baseAsset || candidate.assetClass !== firstCandidate.assetClass)) {
    writeJson(response, 400, { error: "candidate_group_mismatch", message: "all candidates must represent the same base asset and asset class" });
    return;
  }
  const snapshot = deps.configManager.snapshot;
  const candidates = sortCandidates(parsed.candidates, snapshot.config);
  // C8: these are fresh server-side probes. Any probe evidence supplied by the
  // browser is deliberately ignored.
  const probes = await Promise.all(candidates.map((candidate) => probeInstrumentCandidate(candidate, deps)));
  const successfulBySource = new Map<string, { candidate: InstrumentCandidate; probe: InstrumentProbeEvidence }>();
  for (let index = 0; index < probes.length; index += 1) {
    const probe = probes[index];
    const candidate = candidates[index];
    if (probe?.ok && candidate && !successfulBySource.has(candidate.sourceId)) {
      successfulBySource.set(candidate.sourceId, { candidate, probe });
    }
  }
  const successful = [...successfulBySource.values()];
  if (successful.length === 0) {
    writeJson(response, 422, {
      error: "probe_required",
      message: "至少一个真实数据源探测成功后才能保存",
      probes,
    });
    return;
  }
  const primary = successful[0];
  if (!primary?.probe.price || !primary.probe.quoteAsset) {
    writeJson(response, 422, { error: "probe_has_no_price", probes });
    return;
  }
  const existingIds = new Set(snapshot.config.instruments.map((instrument) => instrument.id));
  const instrumentId = nextInstrumentId(firstCandidate.baseAsset, primary.probe.quoteAsset, existingIds);
  const displayName = typeof body.displayName === "string" && body.displayName.trim()
    ? body.displayName.trim().slice(0, 200)
    : firstCandidate.displayName;
  const tags = Array.isArray(body.tags)
    ? body.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim().length > 0).map((tag) => tag.trim()).slice(0, 50)
    : [];
  const sourceBindings: SourceBinding[] = successful.map(({ candidate, probe }) => {
    const source = snapshot.config.sources.find((entry) => entry.id === candidate.sourceId);
    const adapter = source ? deps.adapters.get(source.adapter) : undefined;
    if (!source?.defaultBinding || !adapter || !probe.quoteAsset) throw new Error(`source ${candidate.sourceId} became unavailable during create`);
    const capabilities = candidate.capabilities.filter((capability) =>
      capability !== "instrumentSearch"
      && source.capabilities.includes(capability)
      && adapter.capabilities.includes(capability));
    if (!capabilities.includes("quote")) capabilities.unshift("quote");
    return {
      sourceId: source.id,
      instrumentId,
      enabled: true,
      priority: snapshot.config.sources.findIndex((entry) => entry.id === source.id),
      capabilities,
      providerSymbol: candidate.providerSymbol,
      quoteAsset: probe.quoteAsset,
      conversion: null,
      params: bindingParamsForCandidate(source, candidate),
      cadenceSeconds: source.defaultBinding.cadenceSeconds,
      staleAfterSeconds: source.defaultBinding.staleAfterSeconds,
      egressProfile: source.defaultBinding.egressProfile,
      egressFallback: source.egressFallback,
    };
  });
  for (const binding of [...sourceBindings]) {
    const source = snapshot.config.sources.find(entry => entry.id === binding.sourceId);
    if (source?.adapter !== "tradier-stocks" || !binding.capabilities.includes("quote")) continue;
    const history = snapshot.config.sources.find(entry => entry.adapter === "tradier-stocks" && entry.enabled && entry.baseUrl === source.baseUrl && entry.capabilities.includes("candle") && !entry.capabilities.includes("quote"));
    if (!history?.defaultBinding || sourceBindings.some(entry => entry.sourceId === history.id)) continue;
    sourceBindings.push({ ...binding, sourceId: history.id, priority: binding.priority + 1, capabilities: ["candle"], params: {}, ...history.defaultBinding, egressFallback: history.egressFallback });
  }
  const draft = InstrumentConfigSchema.safeParse({
    id: instrumentId,
    assetClass: firstCandidate.assetClass,
    symbol: `${firstCandidate.baseAsset}/${primary.probe.quoteAsset}`,
    displayName,
    venue: primary.candidate.venue,
    baseAsset: firstCandidate.baseAsset,
    quoteAsset: primary.probe.quoteAsset,
    contractMultiplier: "1",
    underlyingId: null,
    precision: {
      priceScale: Math.max(decimalPlaces(primary.probe.price), priceScaleFallback(firstCandidate.assetClass)),
      quantityScale: quantityScaleFor(firstCandidate.assetClass),
    },
    tags,
    active: true,
    metadata: { createdAt: new Date().toISOString() },
    sourceBindings,
    panelId: "other",
    watch: true,
  });
  if (!draft.success) {
    writeJson(response, 422, { error: "instrument_validation_failed", message: draft.error.message });
    return;
  }
  const stored: StoredInstrumentConfig = {
    ...draft.data,
    origin: "user",
    shadowed: false,
  };
  try {
    await deps.storage.createUserInstrument(stored, Date.now());
  } catch (error) {
    if (errorMessage(error).includes("already exists") || errorMessage(error).includes("UNIQUE")) {
      writeJson(response, 409, { error: "instrument_id_conflict", message: errorMessage(error) });
      return;
    }
    throw error;
  }
  const event = await deps.configManager.reload(true);
  if (event.type !== "loaded" || !event.snapshot) {
    writeJson(response, 500, { error: "runtime_reload_failed", issues: event.issues });
    return;
  }
  const instrument = event.snapshot.config.instruments.find((candidate) => candidate.id === instrumentId);
  writeJson(response, 201, {
    generation: event.snapshot.generation,
    instrument,
    probes,
  });
}

async function patchUserInstrument(
  request: IncomingMessage,
  response: ServerResponse,
  instrumentId: string,
  deps: HttpDependencies,
): Promise<void> {
  const origin = await deps.storage.getInstrumentOrigin(instrumentId);
  if (origin === null) {
    writeJson(response, 404, { error: "instrument_not_found", instrumentId });
    return;
  }
  if (origin === "config") {
    writeJson(response, 403, { error: "config_owned", message: "YAML 标的只能通过 portfolio.yaml 修改" });
    return;
  }
  const body = await readJson(request);
  const changes: { displayName?: string; active?: boolean; tags?: string[] } = {};
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || !body.displayName.trim() || body.displayName.length > 200) {
      writeJson(response, 400, { error: "invalid_display_name" });
      return;
    }
    changes.displayName = body.displayName.trim();
  }
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean") {
      writeJson(response, 400, { error: "invalid_active" });
      return;
    }
    changes.active = body.active;
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string")) {
      writeJson(response, 400, { error: "invalid_tags" });
      return;
    }
    changes.tags = body.tags.map((tag) => String(tag).trim()).filter(Boolean).slice(0, 50);
  }
  if (!await deps.storage.updateUserInstrument(instrumentId, changes, Date.now())) {
    writeJson(response, 400, { error: "no_supported_changes" });
    return;
  }
  const event = await deps.configManager.reload(true);
  writeJson(response, event.type === "loaded" ? 200 : 500, event.type === "loaded"
    ? { updated: true, instrumentId, generation: event.snapshot?.generation ?? deps.configManager.snapshot.generation }
    : { error: "runtime_reload_failed", issues: event.issues });
}

async function deleteUserInstrument(
  response: ServerResponse,
  instrumentId: string,
  hard: boolean,
  deps: HttpDependencies,
): Promise<void> {
  const result = await deps.storage.deleteUserInstrument(instrumentId, hard);
  if (result.status === "not-found") {
    writeJson(response, 404, { error: "instrument_not_found", instrumentId, references: result.references });
    return;
  }
  if (result.status === "config-owned") {
    writeJson(response, 403, { error: "config_owned", message: "YAML 标的不可从 UI 删除，只能修改 portfolio.yaml", references: result.references });
    return;
  }
  if (result.status === "referenced") {
    writeJson(response, 409, {
      error: "instrument_referenced",
      message: "存在关联交易或非零持仓，拒绝硬删除；可使用默认软删除保留历史",
      references: result.references,
    });
    return;
  }
  const event = await deps.configManager.reload(true);
  writeJson(response, event.type === "loaded" ? 200 : 500, event.type === "loaded"
    ? { status: result.status, instrumentId, references: result.references, generation: event.snapshot?.generation ?? deps.configManager.snapshot.generation }
    : { error: "runtime_reload_failed", issues: event.issues });
}

async function probeInstrumentCandidate(
  candidate: InstrumentCandidate,
  deps: HttpDependencies,
): Promise<InstrumentProbeEvidence> {
  const startedAtMs = Date.now();
  const snapshot = deps.configManager.snapshot;
  const source = snapshot.config.sources.find((entry) => entry.id === candidate.sourceId);
  if (!source || !source.enabled) {
    return failedProbe(candidate, startedAtMs, {
      code: source ? "source-disabled" : "source-unknown",
      message: source ? "数据源在 YAML 中未启用" : "未知数据源",
    });
  }
  if (!source.defaultBinding || !source.capabilities.includes("quote")) {
    return failedProbe(candidate, startedAtMs, { code: "quote-unsupported", message: "数据源没有可用的报价默认绑定" });
  }
  const integrityError = candidateIntegrityError(source, candidate);
  if (integrityError) return failedProbe(candidate, startedAtMs, integrityError);
  const adapter = deps.adapters.get(source.adapter);
  if (!adapter || !adapter.capabilities.includes("quote")) {
    return failedProbe(candidate, startedAtMs, { code: "adapter-unavailable", message: "报价适配器不可用" });
  }
  const authToken = await resolveAuthReference(source.authRef).catch(() => null);
  const binding = probeBinding(source, candidate);
  const instrument = InstrumentConfigSchema.parse({
    id: `probe-${candidate.sourceId}`,
    assetClass: candidate.assetClass,
    symbol: candidate.symbol,
    displayName: candidate.displayName,
    venue: candidate.venue,
    baseAsset: candidate.baseAsset,
    quoteAsset: candidate.quoteAsset,
    contractMultiplier: "1",
    underlyingId: null,
    precision: { priceScale: 2, quantityScale: quantityScaleFor(candidate.assetClass) },
    tags: [],
    active: true,
    metadata: {},
    sourceBindings: [binding],
    panelId: "other",
    watch: false,
  });
  const context: AdapterContext = {
    source,
    binding,
    instrument,
    httpClient: deps.httpClient,
    authToken,
    now: new Date().toISOString(),
    clockSkewToleranceMs: snapshot.config.clockSkewToleranceMs,
    requestId: `probe-${source.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capability: "quote",
  };
  try {
    const fetched = await adapter.fetch(context, { ...source.params, ...binding.params }, new AbortController().signal);
    if (!fetched.ok) return failedProbe(candidate, startedAtMs, fetched.error, fetched.error.egressProfileUsed);
    const responseContext = { ...context, now: fetched.value.receivedAt };
    const parsed = adapter.parse(fetched.value, responseContext);
    if (!parsed.ok) return failedProbe(candidate, startedAtMs, parsed.error, fetched.value.egressProfileUsed);
    const normalized = adapter.normalize(parsed.value, responseContext);
    if (!normalized.ok) return failedProbe(candidate, startedAtMs, normalized.error, fetched.value.egressProfileUsed);
    if (normalized.value.kind !== "quote" || normalized.value.value.price === null) {
      return failedProbe(candidate, startedAtMs, { code: "price-unavailable", message: "真实请求未返回可解析价格" }, fetched.value.egressProfileUsed);
    }
    const quote = normalized.value.value;
    return {
      candidate,
      ok: true,
      price: quote.price,
      quoteAsset: quote.quoteAsset,
      capturedAt: quote.capturedAt,
      freshness: quote.freshness,
      egressUsed: fetched.value.egressProfileUsed,
      latencyMs: Date.now() - startedAtMs,
      error: null,
    };
  } catch (error) {
    return failedProbe(candidate, startedAtMs, { code: "probe-failed", message: errorMessage(error) });
  }
}

function failedProbe(
  candidate: InstrumentCandidate,
  startedAtMs: number,
  error: unknown,
  egressUsed: EgressName | null = null,
): InstrumentProbeEvidence {
  return {
    candidate,
    ok: false,
    price: null,
    quoteAsset: null,
    capturedAt: null,
    freshness: null,
    egressUsed,
    latencyMs: Date.now() - startedAtMs,
    error,
  };
}

type BrokerRefreshDependencies = Pick<HttpDependencies, "storage" | "configManager" | "httpClient" | "scheduler" | "events" | "settings">;
/** Snapshot environment a connection writes: report brokers use "statement", paper accounts "sandbox". */
function brokerSnapshotEnvironment(connection: Pick<BrokerConnectionStatus, "id" | "mode">): string {
  return connection.id === "ibkr" ? "statement" : connection.id === "schwab" ? "live" : connection.id === "alpaca" ? (connection.mode === "paper" ? "sandbox" : "live") : connection.mode;
}
async function refreshBrokerAccount(broker: BrokerApiId, deps: BrokerRefreshDependencies): Promise<void> {
  return runBrokerSync(deps.storage, broker, async startedAt => {
    const env = deps.settings?.env() ?? process.env;
    const mode = brokerConnections(env).find(c => c.id === broker)!.mode;
    try {
      // Orders only exist at the broker during their session; keep what earlier syncs saw so nightly history can be matched.
      const orders = broker === "tradier" ? { known: await deps.storage.getBrokerOrderObservations("tradier"), observed: [] } : undefined;
      await deps.storage.saveBrokerSnapshots(await syncBroker(broker, env, undefined, orders));
      if (orders?.observed.length) await deps.storage.saveBrokerOrderObservations(orders.observed);
      await deps.storage.saveBrokerSyncAttempt({ broker, mode, state: "success", startedAt, completedAt: new Date().toISOString(), message: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "券商同步失败";
      await deps.storage.saveBrokerSyncAttempt({ broker, mode, state: "error", startedAt, completedAt: new Date().toISOString(), message });
      throw error;
    }
    await enrichHeldMultipliers(deps).catch(() => false);
    if (typeof deps.configManager?.reload === "function") await deps.configManager.reload(true);
    await syncAutomaticTradingCases(deps.storage);
    if (deps.configManager) {
      deps.scheduler?.setBackgroundQuoteInstruments?.(await heldQuoteInstrumentIds(deps.configManager.snapshot.config, deps.storage));
      deps.events?.publish("pnl.updated", deps.configManager.snapshot.generation, { reason: "broker-synced", broker });
      // New holdings may need betas; estimate them in the background before the page asks.
      if (typeof deps.configManager.snapshot?.config === "object") void riskExposureRuntime({ storage: deps.storage, configManager: deps.configManager, httpClient: deps.httpClient }).then(warmRiskBetas).catch(() => undefined);
    }
  });
}

async function enrichHeldMultipliers(deps: Pick<HttpDependencies, "storage" | "configManager" | "httpClient">): Promise<boolean> {
  const initial = await deps.storage.getBrokerSnapshots();
  const pending = [...new Set(initial.flatMap(a => a.positions.filter(p => p.currency === "USD" && p.multiplier == null && /^[A-Z][A-Z0-9.]{0,5}\d{6}[CP]\d{8}$/.test(p.symbol.replace(/\s+/g, ""))).map(p => p.symbol.replace(/\s+/g, ""))))];
  if (!pending.length) return false;
  const source = deps.configManager.snapshot.config.sources.find(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote") && s.defaultBinding);
  if (!source) return false;
  const auth = await resolveAuthReference(source.authRef);
  if (!auth) return false;
  const sizes = new Map<string, string>();
  for (let i = 0; i < pending.length; i += 50) {
    const result = await tradierMarketData(new URL(`/api/market/quotes?symbols=${encodeURIComponent(pending.slice(i, i + 50).join(","))}`, "http://localhost"), discoveryContext(source, deps.httpClient, auth));
    if (result.status !== 200 || !Array.isArray(result.body.quotes)) continue;
    for (const q of result.body.quotes) if (q && typeof q === "object" && typeof q.symbol === "string" && typeof q.contractSize === "string" && q.type === "option") sizes.set(q.symbol, q.contractSize);
  }
  if (!sizes.size) return false;
  const current = await deps.storage.getBrokerSnapshots();
  const updates = current.filter(a => a.positions.some(p => p.multiplier == null && sizes.has(p.symbol.replace(/\s+/g, "")))).map(a => ({ ...a, positions: a.positions.map(p => p.multiplier == null && sizes.has(p.symbol.replace(/\s+/g, "")) ? { ...p, multiplier: sizes.get(p.symbol.replace(/\s+/g, ""))! } : p) }));
  await deps.storage.saveBrokerSnapshots(updates);
  return updates.length > 0;
}

// Quote and history readers for the risk-exposure analysis share the Tradier quote source, cache and quota; without
// a Tradier source the analysis falls back to broker-reported prices.
async function riskExposureRuntime(deps: { storage: StorageDriver; configManager: ConfigManager; httpClient?: EgressHttpClient }): Promise<RiskExposureDeps> {
  const config = deps.configManager.snapshot.config;
  const source = config.sources.find(s => s.enabled && s.adapter === "tradier-stocks" && s.capabilities.includes("quote") && s.defaultBinding);
  const context = source && deps.httpClient ? { ...discoveryContext(source, deps.httpClient, await resolveAuthReference(source.authRef)), capability: "quote" as const } : null;
  const market = async (path: string) => { const reply = await tradierMarketData(new URL(path, "http://localhost"), context!); if (reply.status !== 200) throw new Error(String(reply.body.message ?? "Tradier 行情不可用")); return reply.body; };
  return { storage: deps.storage, config,
    fetchQuotes: context ? async symbols => (await market(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(","))}`)).quotes as MarketQuote[] : undefined,
    fetchHistory: context ? async symbol => ((await market(`/api/market/history?symbol=${encodeURIComponent(symbol)}`)).candles as { openTime: string; close: string }[]).map(c => ({ date: newYorkTime(Date.parse(c.openTime)).date, close: c.close })) : undefined };
}

function discoveryContext(
  source: SourceConfig,
  httpClient: EgressHttpClient,
  authToken: string | null,
): AdapterContext {
  if (!source.defaultBinding) throw new Error(`${source.id} is missing defaultBinding`);
  const binding: SourceBinding = {
    sourceId: source.id,
    instrumentId: "instrument-search",
    enabled: true,
    priority: 0,
    capabilities: ["instrumentSearch"],
    providerSymbol: "SEARCH",
    quoteAsset: "USD",
    conversion: null,
    params: {},
    cadenceSeconds: source.defaultBinding.cadenceSeconds,
    staleAfterSeconds: source.defaultBinding.staleAfterSeconds,
    egressProfile: source.defaultBinding.egressProfile,
    egressFallback: source.egressFallback,
  };
  return {
    source,
    binding,
    instrument: {
      id: "instrument-search",
      assetClass: "other",
      symbol: "SEARCH",
      displayName: "Instrument search",
      venue: null,
      baseAsset: "SEARCH",
      quoteAsset: "USD",
      contractMultiplier: "1",
      underlyingId: null,
      precision: { priceScale: 2, quantityScale: 6 },
      tags: [],
      active: false,
      metadata: {},
    },
    httpClient,
    authToken,
    now: new Date().toISOString(),
    clockSkewToleranceMs: DEFAULT_CLOCK_SKEW_TOLERANCE_MS,
    requestId: `search-${source.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    capability: "instrumentSearch",
  };
}

function discoveryUnavailableReason(source: SourceConfig, authToken: string | null, adapters: AdapterRegistry) {
  const adapter = adapters.get(source.adapter);
  if (!adapter?.searchInstruments) return { code: "search-unsupported", message: "该数据源未实现标的搜索", steps: [] };
  if (source.authRef !== null && authToken === null) {
    return {
      code: "auth-missing",
      message: source.adapter === "massive-stocks"
        ? "股票搜索未启用：缺少 MASSIVE_API_KEY"
        : source.adapter === "tradier-stocks" ? "股票 / ETF 搜索待配置：缺少 TRADIER_ACCESS_TOKEN" : `数据源 ${source.id} 缺少凭据`,
      steps: sourceEnablementSteps(source),
    };
  }
  if (!source.enabled) {
    return {
      code: "source-disabled",
      message: `数据源 ${source.id} 在 YAML 中未启用`,
      steps: [`在 portfolio.yaml 中将 sources.${source.id}.enabled 设为 true`, "触发配置 reload"],
    };
  }
  return null;
}

function massiveEnablementSteps(): string[] {
  return [
    "在服务环境设置 MASSIVE_API_KEY",
    "在 portfolio.yaml 中将 massive-stocks.enabled 设为 true",
    "触发配置 reload",
  ];
}

function sourceEnablementSteps(source: SourceConfig): string[] {
  if (source.adapter === "tradier-stocks") return ["在服务器 .env 填写 TRADIER_ACCESS_TOKEN，并设置匹配的 TRADIER_ENVIRONMENT=live 或 sandbox", "在项目目录执行 docker compose --env-file .env up -d --force-recreate --wait api web"];
  return source.adapter === "massive-stocks" ? massiveEnablementSteps() : [];
}

function probeBinding(source: SourceConfig, candidate: InstrumentCandidate): SourceBinding {
  if (!source.defaultBinding) throw new Error(`${source.id} is missing defaultBinding`);
  const capabilities = candidate.capabilities.filter((capability) => capability !== "instrumentSearch" && source.capabilities.includes(capability));
  if (!capabilities.includes("quote")) capabilities.unshift("quote");
  return {
    sourceId: source.id,
    instrumentId: `probe-${source.id}`,
    enabled: true,
    priority: 0,
    capabilities,
    providerSymbol: candidate.providerSymbol,
    quoteAsset: candidate.quoteAsset,
    conversion: null,
    params: bindingParamsForCandidate(source, candidate),
    cadenceSeconds: source.defaultBinding.cadenceSeconds,
    staleAfterSeconds: source.defaultBinding.staleAfterSeconds,
    egressProfile: source.defaultBinding.egressProfile,
    egressFallback: source.egressFallback,
  };
}

function bindingParamsForCandidate(source: SourceConfig, candidate: InstrumentCandidate): Record<string, unknown> {
  if (source.adapter === "gold-api") {
    return {
      metal: candidate.providerSymbol,
      quoteAsset: candidate.quoteAsset,
      unit: source.params.unit ?? "troy_ounce",
    };
  }
  if (source.adapter === "coingecko") return { vsCurrency: candidate.quoteAsset.toLowerCase() };
  return {};
}

function candidateIntegrityError(source: SourceConfig, candidate: InstrumentCandidate): { code: string; message: string } | null {
  if (source.adapter === "binance-vision") {
    const nativeQuoteAsset = ["USDT", "USDC", "FDUSD"].find((quoteAsset) => candidate.providerSymbol.endsWith(quoteAsset));
    const nativeBaseAsset = nativeQuoteAsset ? candidate.providerSymbol.slice(0, -nativeQuoteAsset.length) : null;
    if (!nativeQuoteAsset || nativeQuoteAsset !== candidate.quoteAsset || nativeBaseAsset !== candidate.baseAsset || candidate.assetClass !== "crypto") {
      return { code: "candidate-integrity", message: "Binance 候选的原生 baseAsset/quoteAsset 与 providerSymbol 不一致" };
    }
  }
  if (source.adapter === "coingecko" && (candidate.quoteAsset !== "USD" || candidate.assetClass !== "crypto")) {
    return { code: "candidate-integrity", message: "CoinGecko 候选必须使用原生 USD 计价与 crypto 分类" };
  }
  if (source.adapter === "gold-api" && (
    !["XAU", "XAG", "XPT", "XPD", "HG"].includes(candidate.providerSymbol)
    || candidate.baseAsset !== candidate.providerSymbol
    || candidate.quoteAsset !== "USD"
    || candidate.assetClass !== "preciousMetal"
  )) {
    return { code: "candidate-integrity", message: "Gold API 候选不符合贵金属原生符号或 USD 计价约束" };
  }
  if (["massive-stocks", "tradier-stocks"].includes(source.adapter) && (
    candidate.baseAsset !== (source.adapter === "tradier-stocks" ? candidate.providerSymbol.replaceAll("/", ".") : candidate.providerSymbol)
    || candidate.quoteAsset !== "USD"
    || candidate.assetClass !== "equity"
  )) {
    return { code: "candidate-integrity", message: "股票候选不符合原生 ticker 或 USD 计价约束" };
  }
  return null;
}

function parseCandidateList(value: unknown):
  | { readonly ok: true; readonly candidates: InstrumentCandidate[] }
  | { readonly ok: false; readonly message: string } {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    return { ok: false, message: "candidates must contain between 1 and 20 entries" };
  }
  const candidates: InstrumentCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const parsed = InstrumentCandidateSchema.safeParse(entry);
    if (!parsed.success) return { ok: false, message: parsed.error.message };
    const key = `${parsed.data.sourceId}\u0000${parsed.data.providerSymbol}`;
    if (!seen.has(key)) candidates.push(parsed.data);
    seen.add(key);
  }
  return { ok: true, candidates };
}

function sortCandidates(candidates: readonly InstrumentCandidate[], config: AppConfig): InstrumentCandidate[] {
  const sourceOrder = new Map(config.sources.map((source, index) => [source.id, index]));
  return [...candidates].sort((left, right) =>
    (sourceOrder.get(left.sourceId) ?? Number.MAX_SAFE_INTEGER) - (sourceOrder.get(right.sourceId) ?? Number.MAX_SAFE_INTEGER)
    || rankForSort(left.rank) - rankForSort(right.rank));
}

function rankForSort(rank: number | null): number {
  return rank ?? Number.MAX_SAFE_INTEGER;
}

function instrumentSearchMatchLevel(candidate: InstrumentCandidate, query: string): number {
  const needle = query.trim().toUpperCase();
  const values = [candidate.baseAsset, candidate.symbol].map((value) => value.toUpperCase());
  if (values.some((value) => value === needle)) return 0;
  if (values.some((value) => value.startsWith(needle))) return 1;
  if (values.some((value) => value.includes(needle))) return 2;
  return 3;
}

function nextInstrumentId(baseAsset: string, quoteAsset: string, existingIds: ReadonlySet<string>): string {
  const base = `${baseAsset}-${quoteAsset}`.toLowerCase();
  if (!existingIds.has(base)) return base;
  let suffix = 2;
  while (existingIds.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function decimalPlaces(value: string): number {
  const separator = value.indexOf(".");
  return separator < 0 ? 0 : value.length - separator - 1;
}

function priceScaleFallback(assetClass: InstrumentCandidate["assetClass"]): number {
  return assetClass === "crypto" || assetClass === "preciousMetal" || assetClass === "equity" ? 2 : 2;
}

function quantityScaleFor(assetClass: InstrumentCandidate["assetClass"]): number {
  return assetClass === "crypto" ? 8 : 6;
}

function instrumentIdFromPath(pathname: string): string | null {
  const encoded = pathname.slice("/api/instruments/".length);
  if (!encoded || encoded.includes("/")) return null;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

function authEnabled(deps: HttpDependencies): boolean {
  return deps.authMode !== "off";
}

function requestAuthorized(request: IncomingMessage, deps: HttpDependencies): boolean {
  if (!authEnabled(deps)) return true;
  return (deps.authToken !== null && authorizedBearer(request, deps.authToken))
    || authorizedSession(request, deps.sessions);
}

function bearerAuthorized(request: IncomingMessage, deps: HttpDependencies): boolean {
  return deps.authToken !== null && authorizedBearer(request, deps.authToken);
}

function authorizedBearer(request: IncomingMessage, expectedToken: string): boolean {
  const suppliedToken = bearerToken(request);
  return suppliedToken !== null && tokenMatches(suppliedToken, expectedToken);
}

function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length);
}

function tokenMatches(suppliedToken: string, expectedToken: string): boolean {
  const supplied = Buffer.from(suppliedToken);
  const expected = Buffer.from(expectedToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authorizedSession(request: IncomingMessage, sessions: SessionStore): boolean {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME);
  return sessionId !== null && sessions.isValid(sessionId);
}

async function createSession(request: IncomingMessage, response: ServerResponse, deps: HttpDependencies): Promise<void> {
  if (!authEnabled(deps)) {
    writeJson(response, 200, { authenticated: true, usingInitialPassword: false });
    return;
  }

  const body = await readJson(request);
  if (bearerAuthorized(request, deps)) {
    issueSession(response, deps, false);
    return;
  }

  if (deps.authMode === "token") {
    const bodyToken = typeof body.token === "string" && body.token.trim().length > 0
      ? body.token.trim()
      : null;
    if (bodyToken !== null && deps.authToken !== null && tokenMatches(bodyToken, deps.authToken)) {
      issueSession(response, deps, false);
      return;
    }
    writeUnauthorized(response);
    return;
  }

  if (!deps.passwordAuth) {
    writeUnauthorized(response);
    return;
  }

  const clientAddress = clientAddressFor(request);
  const retryAfterMs = deps.loginRateLimiter.retryAfterMs(clientAddress);
  if (retryAfterMs > 0) {
    writeLoginRateLimited(response, retryAfterMs);
    return;
  }

  const suppliedPassword = typeof body.password === "string" ? body.password : "";
  const passwordMatches = Buffer.byteLength(suppliedPassword, "utf8") <= MAX_PASSWORD_LENGTH
    && await verifyPassword(suppliedPassword, deps.passwordAuth.credential);
  if (!passwordMatches) {
    const failureRetryAfterMs = deps.loginRateLimiter.recordFailure(clientAddress);
    if (failureRetryAfterMs > 0) {
      writeLoginRateLimited(response, failureRetryAfterMs);
    } else {
      writeCredentialError(response, "密码错误");
    }
    return;
  }

  deps.loginRateLimiter.recordSuccess(clientAddress);
  issueSession(response, deps, deps.passwordAuth.credential.isInitial);
}

function issueSession(response: ServerResponse, deps: HttpDependencies, usingInitialPassword: boolean): void {
  const sessionId = deps.sessions.create();
  response.setHeader("set-cookie", sessionCookie(sessionId, deps.secureSessionCookie));
  writeJson(response, 200, { authenticated: true, usingInitialPassword });
}

async function changePassword(request: IncomingMessage, response: ServerResponse, deps: HttpDependencies): Promise<void> {
  if (!deps.passwordAuth) {
    writeJson(response, 404, { error: "password_auth_unavailable" });
    return;
  }

  const body = await readJson(request);
  const currentPassword = typeof body.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  if (!currentPassword) {
    writeJson(response, 400, { error: "current_password_required", message: "请输入当前密码" });
    return;
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    writeJson(response, 400, { error: "password_too_short", message: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` });
    return;
  }
  if (Buffer.byteLength(newPassword, "utf8") > MAX_PASSWORD_LENGTH) {
    writeJson(response, 400, { error: "password_too_long", message: "新密码过长，请控制在 1024 位以内" });
    return;
  }

  const currentMatches = Buffer.byteLength(currentPassword, "utf8") <= MAX_PASSWORD_LENGTH
    && await verifyPassword(currentPassword, deps.passwordAuth.credential);
  if (!currentMatches) {
    writeJson(response, 401, { error: "invalid_current_password", message: "当前密码错误" });
    return;
  }

  const next = await hashPassword(newPassword);
  const updatedAtMs = Date.now();
  await deps.storage.updatePasswordCredential({
    passwordHash: next.passwordHash,
    passwordSalt: next.passwordSalt,
    isInitial: false,
    updatedAtMs,
  });
  deps.passwordAuth.credential = {
    passwordHash: next.passwordHash,
    passwordSalt: next.passwordSalt,
    isInitial: false,
    updatedAtMs,
  };

  const sessionId = readCookie(request, SESSION_COOKIE_NAME);
  const keepSessionId = sessionId !== null && deps.sessions.isValid(sessionId) ? sessionId : null;
  deps.sessions.revokeAllExcept(keepSessionId);
  writeJson(response, 200, { changed: true, usingInitialPassword: false });
}

function revokeSession(request: IncomingMessage, response: ServerResponse, deps: HttpDependencies): void {
  const sessionId = readCookie(request, SESSION_COOKIE_NAME);
  if (sessionId !== null) deps.sessions.revoke(sessionId);
  response.setHeader("set-cookie", clearSessionCookie(deps.secureSessionCookie));
  response.statusCode = 204;
  response.end();
}

function hasRequestedWithHeader(request: IncomingMessage): boolean {
  return request.headers["x-requested-with"] === "XMLHttpRequest";
}

function writeUnauthorized(response: ServerResponse): void {
  response.setHeader("www-authenticate", "Bearer");
  writeJson(response, 401, { error: "unauthorized" });
}

function writeCredentialError(response: ServerResponse, message: string): void {
  writeJson(response, 401, { error: "invalid_credentials", message });
}

function writeLoginRateLimited(response: ServerResponse, retryAfterMs: number): void {
  response.setHeader("retry-after", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  writeJson(response, 429, {
    error: "login_rate_limited",
    message: "尝试过于频繁，请稍后再试",
  });
}

function clientAddressFor(request: IncomingMessage): string {
  const forwarded = request.headers["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const forwardedParts = firstForwarded?.split(",").map((part) => part.trim()).filter(Boolean) ?? [];
  const address = forwardedParts.at(-1);
  return address || request.socket.remoteAddress || "unknown";
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie;
  if (!header) return null;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const key = pair.slice(0, separator).trim();
    if (key === name) return pair.slice(separator + 1).trim() || null;
  }
  return null;
}

function sessionCookie(sessionId: string, secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE_NAME}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

async function writeInstrumentQuotes(response: ServerResponse, instrumentId: string, deps: {
  configManager: ConfigManager;
  storage: StorageDriver;
  scheduler: CollectorScheduler;
}): Promise<void> {
  const snapshot = deps.configManager.snapshot;
  const instrument = snapshot.config.instruments.find((candidate) => candidate.id === instrumentId);
  if (!instrument) {
    writeJson(response, 404, { error: "instrument_not_configured", instrumentId });
    return;
  }
  writeJson(response, 200, {
    generation: snapshot.generation,
    instrument,
    quotes: await quoteEnvelopes(instrument, snapshot, deps),
  });
}

interface QuoteObservations { quotes: StoredQuoteRow[]; health: StoredSourceHealthRow[] }
async function quoteObservations(storage: StorageDriver): Promise<QuoteObservations> {
  const [quotes, health] = await Promise.all([storage.getLatestQuotes(), storage.getLatestSourceHealth()]);
  return { quotes, health };
}

async function quoteEnvelopes(
  instrument: InstrumentConfig,
  snapshot: ConfigSnapshot,
  deps: { storage: StorageDriver; scheduler: CollectorScheduler },
  observations?: QuoteObservations,
) {
  const rows = observations ? observations.quotes.filter(q => q.instrumentId === instrument.id) : await deps.storage.getLatestQuotes(instrument.id);
  const health = observations?.health ?? await deps.storage.getLatestSourceHealth();
  const rowBySource = new Map(rows.map((row) => [row.sourceId, row]));
  const healthByKey = new Map(health.map((entry) => [`${entry.sourceId}\u0000${entry.capability}`, entry]));
  return instrument.sourceBindings
    .filter((binding) => binding.enabled && binding.capabilities.includes("quote"))
    .map((binding) => {
      const source = snapshot.config.sources.find((candidate) => candidate.id === binding.sourceId);
      const row = rowBySource.get(binding.sourceId);
      const sourceHealth = healthByKey.get(`${binding.sourceId}\u0000quote`) ?? null;
      const sourceAvailable = source?.enabled === true && deps.scheduler.sourceCapabilityAvailable(binding.sourceId, "quote");
      const quote = sourceAvailable && row
        ? quoteFromRow(
          row,
          binding.staleAfterSeconds,
          sourceHealth,
          snapshot.config.clockSkewToleranceMs,
          deps.scheduler.sourceFreshnessClass(binding.sourceId),
          source?.adapter === "tradier-stocks",
          deps.scheduler.sourceMarketState?.(binding.sourceId) ?? "unknown",
          deps.scheduler.sourceTradeSession?.(binding.sourceId, new Date(row.capturedAtMs).toISOString(), instrument.assetClass) ?? {},
        )
        : null;
      return {
        instrumentId: instrument.id,
        sourceId: binding.sourceId,
        providerSymbol: binding.providerSymbol,
        quoteAsset: binding.quoteAsset,
        priority: binding.priority,
        egressProfile: binding.egressProfile,
        quote,
        freshness: sourceAvailable && row
          ? quote?.freshness ?? unavailableFreshness(binding.staleAfterSeconds, snapshot.config.clockSkewToleranceMs)
          : unavailableFreshness(binding.staleAfterSeconds, snapshot.config.clockSkewToleranceMs),
        sourceHealth,
      };
    });
}

function quoteFromRow(
  row: StoredQuoteRow,
  staleAfterSeconds: number,
  health: StoredSourceHealthRow | null,
  clockSkewToleranceMs: number,
  freshnessClass: FreshnessClass,
  tradeBased = false,
  marketState: "open" | "closed" | "premarket" | "postmarket" | "unknown" = "unknown",
  tradeSession: Partial<Pick<Freshness, "tradeSession" | "tradeSessionDate" | "sessionBasis">> = {},
): Quote | null {
  const capturedAt = new Date(row.capturedAtMs).toISOString();
  const receivedAt = new Date(row.receivedAtMs).toISOString();
  const freshness = tradeBased ? computeTradeFreshness(capturedAt, receivedAt, capturedAt, staleAfterSeconds, new Date(), freshnessClass, clockSkewToleranceMs, marketState)
    : computeFreshness(capturedAt, receivedAt, staleAfterSeconds, new Date(), freshnessClass, clockSkewToleranceMs);
  Object.assign(freshness, tradeSession);
  if (health && health.status !== "healthy" && health.observedAtMs >= row.receivedAtMs) {
    freshness.status = "stale";
    freshness.isStale = true;
  }
  const parsed = QuoteSchema.safeParse({
    instrumentId: row.instrumentId,
    sourceId: row.sourceId,
    providerSymbol: row.providerSymbol,
    price: row.price,
    bid: row.bid,
    ask: row.ask,
    mid: row.mid,
    dayOpen: row.dayOpen,
    dayHigh: row.dayHigh,
    dayLow: row.dayLow,
    previousClose: row.previousClose,
    volume: row.volume,
    quoteAsset: row.quoteAsset,
    convertedTo: parseJsonOrNull(row.convertedToJson),
    capturedAt,
    receivedAt,
    freshness,
    quality: row.quality,
    rawRef: row.rawEventId === null ? null : String(row.rawEventId),
  });
  return parsed.success ? parsed.data : null;
}

function unavailableFreshness(staleAfterSeconds: number, clockSkewToleranceMs: number): Freshness {
  const now = new Date().toISOString();
  return FreshnessSchema.parse({
    ...computeFreshness(now, now, staleAfterSeconds, new Date(now), "realtime", clockSkewToleranceMs),
    isStale: true,
    status: "unavailable",
  });
}

async function buildViewDescriptor(
  snapshot: ConfigSnapshot,
  deps: { storage: StorageDriver; scheduler: CollectorScheduler },
  observations?: QuoteObservations,
) {
  observations ??= await quoteObservations(deps.storage);
  const panels = await Promise.all(snapshot.config.instruments
    .filter((instrument) => instrument.active)
    .map(async (instrument) => {
      const quotes = await quoteEnvelopes(instrument, snapshot, deps, observations);
      const availableCapabilities = [...new Set(instrument.sourceBindings
        .filter((binding) => binding.enabled)
        .flatMap((binding) => binding.capabilities.filter((capability) =>
          deps.scheduler.sourceCapabilityAvailable(binding.sourceId, capability))))] as Capability[];
      if (newsCapabilityAvailable(snapshot)) availableCapabilities.push("news");
      const quoteBindings = instrument.sourceBindings
        .filter((binding) => binding.enabled
          && binding.capabilities.includes("quote")
          && deps.scheduler.sourceCapabilityAvailable(binding.sourceId, "quote"))
        .sort((left, right) => left.priority - right.priority);
      const candleBindings = instrument.sourceBindings
        .filter((binding) => binding.enabled
          && binding.capabilities.includes("candle")
          && deps.scheduler.sourceCapabilityAvailable(binding.sourceId, "candle"))
        .sort((left, right) => left.priority - right.priority);
      const widgets = [
        {
          id: `${instrument.id}:quote-card`,
          kind: "quote-card" as const,
          title: "Source comparison / 多源报价",
          dataEndpoint: `/api/quotes?instrumentId=${encodeURIComponent(instrument.id)}`,
          requiredCapabilities: ["quote" as const],
          fieldMap: {
            panel: "panel",
            quotes: "quotes",
            instrumentId: "instrumentId",
            sourceId: "sourceId",
            quote: "quote",
            freshness: "freshness",
            quoteAsset: "quoteAsset",
            priority: "priority",
            egressProfile: "egressProfile",
            sourceHealth: "sourceHealth",
          },
          options: {
            comparison: true,
            ...(() => {
              const tradier = snapshot.config.sources.find(source => source.adapter === "tradier-stocks" && instrument.sourceBindings.some(binding => binding.enabled && binding.sourceId === source.id && binding.capabilities.includes("quote")));
              if (!tradier) return {};
              return {
                unavailableReason: !deps.scheduler.sourceAuthConfigured(tradier.id) ? "Tradier 美股行情待配置：请在服务器 .env 填写 TRADIER_ACCESS_TOKEN，并重新创建服务容器。" : "Tradier 美股行情尚不可用，请检查数据源配置及 Token 权限。",
                sourceNote: new URL(tradier.baseUrl).hostname === "sandbox.tradier.com" ? "Tradier 模拟环境 · 延迟约 15 分钟 · 按最近成交时间判断时效" : "Tradier 实盘行情 · 约每 30 秒采样 · 按最近成交时间判断时效，休市时保留最后报价",
              };
            })(),
          },
        },
        {
          id: `${instrument.id}:health`,
          kind: "health-badge" as const,
          title: "Source health / 源健康",
          dataEndpoint: "/api/source-health",
          requiredCapabilities: [],
          fieldMap: { health: "health", egress: "egress", sourceId: "sourceId", capability: "capability" },
          options: {},
        },
        ...(snapshot.config.sources.some((source) => source.capabilities.includes("news")) ? [{
          id: `${instrument.id}:news`,
          kind: "news-feed" as const,
          title: "Market intelligence / 市场情报",
          dataEndpoint: `/api/news?instrumentId=${encodeURIComponent(instrument.id)}&limit=12`,
          requiredCapabilities: ["news" as const],
          fieldMap: { news: "news", title: "title", summary: "summary", publishedAt: "publishedAt", sourceId: "sourceId" },
          options: { limit: 12 },
        }] : []),
        ...quoteBindings.map((binding) => ({
          id: `${instrument.id}:${binding.sourceId}:sparkline`,
          kind: "sparkline" as const,
          title: `Recent quote history / 最近报价 · ${binding.sourceId} ${binding.quoteAsset}`,
          dataEndpoint: `/api/quotes/history?instrumentId=${encodeURIComponent(instrument.id)}&sourceId=${encodeURIComponent(binding.sourceId)}&limit=80`,
          requiredCapabilities: ["quote" as const],
          fieldMap: { history: "history", value: "price", capturedAt: "capturedAtMs", quoteAsset: "quoteAsset" },
          options: { height: 120, sourceId: binding.sourceId, quoteAsset: binding.quoteAsset, ...(snapshot.config.sources.find(s => s.id === binding.sourceId)?.adapter === "tradier-stocks" ? { intradaySymbol: binding.providerSymbol } : {}) },
        })),
        ...(!candleBindings.length ? [{ id: `${instrument.id}:daily-unavailable`, kind: "candlestick" as const, title: "日 K", dataEndpoint: "/api/candles", requiredCapabilities: ["candle" as const], fieldMap: {}, options: { timeframe: "1d", sourceId: "当前数据源", unavailableReason: "当前数据源尚未提供这个标的的日 K 线。可切换分时图查看已采集报价。" } }] : []),
        ...candleBindings.map(candleBinding => {
          const candleTimeframe = configuredCandleTimeframe(candleBinding, snapshot);
          return {
          id: `${instrument.id}:${candleBinding.sourceId}:candlestick`,
          kind: "candlestick" as const,
          title: `Candles / K 线 · ${candleTimeframe}`,
          dataEndpoint: `/api/candles?instrumentId=${encodeURIComponent(instrument.id)}&sourceId=${encodeURIComponent(candleBinding.sourceId)}&timeframe=${encodeURIComponent(candleTimeframe)}&limit=240&indicators=ma`,
          requiredCapabilities: ["candle" as const],
          fieldMap: {
            candles: "candles",
            open: "open",
            high: "high",
            low: "low",
            close: "close",
            openTime: "openTime",
            quoteAsset: "quoteAsset",
            freshness: "freshness",
          },
          options: {
            sourceId: candleBinding.sourceId, timeframe: candleTimeframe, height: 180,
            ...(snapshot.config.sources.find(source => source.id === candleBinding.sourceId)?.adapter === "tradier-stocks" ? { sourceNote: "Tradier 日 K · 常规交易时段收盘价 · 不混入盘前、盘后或夜盘报价 · 仅含已完成历史交易日 · 不保证股息复权" } : {}),
          },
        }; }),
      ];
      const bestFreshness = quotes
        .filter((entry) => entry.freshness)
        .sort((left, right) => freshnessRank(left.freshness.status) - freshnessRank(right.freshness.status) || left.priority - right.priority)[0]?.freshness ?? null;
      return {
        panelId: instrument.panelId,
        instrumentId: instrument.id,
        title: instrument.displayName,
        assetClass: instrument.assetClass,
        widgets,
        availableCapabilities,
        freshness: bestFreshness,
      };
    }));
  const portfolioPanel = {
    panelId: "portfolio",
    instrumentId: "portfolio-manual",
    title: "券商持仓与盈亏",
    assetClass: "other" as const,
    widgets: [
      {
        id: "portfolio:pnl-summary",
        kind: "pnl-summary" as const,
        title: "盈亏摘要",
        dataEndpoint: "/api/pnl/summary",
        requiredCapabilities: [],
        fieldMap: { summary: "pnlSummary" },
        options: {},
      },
      {
        id: "portfolio:transaction-form",
        kind: "transaction-form" as const,
        title: "录入交易",
        dataEndpoint: "/api/transactions",
        requiredCapabilities: [],
        fieldMap: { transactions: "transactions" },
        options: { accountId: "manual" },
      },
      {
        id: "portfolio:position-table",
        kind: "position-table" as const,
        title: "持仓明细",
        dataEndpoint: "/api/positions",
        requiredCapabilities: [],
        fieldMap: { positions: "positions" },
        options: {},
      },
      { id: "portfolio:history", kind: "transaction-history" as const, title: "交易账本", dataEndpoint: "/api/transactions", requiredCapabilities: [], fieldMap: {}, options: {} },
    ],
    availableCapabilities: [],
    freshness: null,
  };
  const intelPanel = {
    panelId: "intel",
    instrumentId: "global-intel",
    title: "全站情报",
    assetClass: "other" as const,
    widgets: [{
      id: "global:news",
      kind: "news-feed" as const,
      title: "市场情报",
      dataEndpoint: "/api/news?limit=200",
      requiredCapabilities: [],
      fieldMap: { news: "news" },
      options: { limit: 200 },
    }],
    availableCapabilities: [],
    freshness: null,
  };
  const systemPanel = {
    panelId: "system",
    instrumentId: "global-system",
    title: "系统状态",
    assetClass: "other" as const,
    widgets: [{
      id: "global:health",
      kind: "health-badge" as const,
      title: "数据源健康与实际出口",
      dataEndpoint: "/api/source-health",
      requiredCapabilities: [],
      fieldMap: { health: "health", egress: "egress" },
      options: {},
    }],
    availableCapabilities: [],
    freshness: null,
  };
  const researchPanel = { panelId: "research", instrumentId: "global-research", title: "宏观观察与交易复盘", assetClass: "other" as const,
    widgets: [{ id: "global:research", kind: "research-journal" as const, title: "判断日志", dataEndpoint: "/api/research", requiredCapabilities: [], fieldMap: {}, options: {} }], availableCapabilities: [], freshness: null };
  const settingsPanel = { panelId: "settings", instrumentId: "global-settings", title: "账号设置", assetClass: "other" as const,
    widgets: [{ id: "global:settings", kind: "account-settings" as const, title: "券商 API、LLM 与网络出口", dataEndpoint: "/api/settings", requiredCapabilities: [], fieldMap: {}, options: {} }], availableCapabilities: [], freshness: null };
  const brokersPanel = { panelId: "brokers", instrumentId: "global-brokers", title: "券商账户", assetClass: "other" as const,
    widgets: [{ id: "global:brokers", kind: "broker-accounts" as const, title: "账户与成交同步", dataEndpoint: "/api/brokers", requiredCapabilities: [], fieldMap: {}, options: {} }], availableCapabilities: [], freshness: null };
  const tradingReviewPanel = { panelId: "trading-review", instrumentId: "global-trading-review", title: "交易复盘", assetClass: "other" as const,
    widgets: [{ id: "global:trading-review", kind: "trading-review" as const, title: "成交、复盘与宏观周报", dataEndpoint: "/api/trading-review", requiredCapabilities: [], fieldMap: {}, options: {} }], availableCapabilities: [], freshness: null };
  const optionsPanel = { panelId: "tradier-options", instrumentId: "global-options", title: "Tradier 期权行情", assetClass: "option" as const,
    widgets: [{ id: "global:options", kind: "option-chain" as const, title: "期权链与合约行情", dataEndpoint: "/api/options", requiredCapabilities: [], fieldMap: {}, options: { provider: "Tradier" } }], availableCapabilities: [], freshness: null };
  const allPanels = [...panels, portfolioPanel, intelPanel, systemPanel, researchPanel, brokersPanel, tradingReviewPanel, optionsPanel];
  const layout = allPanels.flatMap((panel, panelIndex) => panel.widgets.map((widget, widgetIndex) => ({
    widgetId: widget.id,
    x: widgetIndex % 2,
    y: panelIndex * 4 + Math.floor(widgetIndex / 2),
    w: widget.kind === "quote-card" || widget.kind === "news-feed" || widget.kind === "position-table" ? 2 : 1,
    h: widget.kind === "candlestick" || widget.kind === "news-feed" ? 2 : 1,
  })));
  const matchedSectionIds = new Map<string, string[]>();
  for (const instrument of snapshot.config.instruments.filter((entry) => entry.active)) {
    const capabilities = new Set(instrument.sourceBindings.flatMap((binding) => binding.capabilities));
    const matching = snapshot.config.sections
      .filter((section) => section.id !== "other" && instrumentMatchesSection(instrument, section))
      .map((section) => section.id);
    matchedSectionIds.set(instrument.id, matching.length > 0 ? matching : ["other"]);
  }
  const assetSections = [...snapshot.config.sections]
    .filter((section) => section.id !== "other")
    .sort((left, right) => left.order - right.order)
    .map((section) => ({
      id: section.id,
      title: section.title,
      order: section.order,
      showPositionSummary: section.id !== "options",
      panels: section.id === "options" ? [optionsPanel] : panels
        .filter((panel) => matchedSectionIds.get(panel.instrumentId)?.includes(section.id))
        .map((panel) => ({
          ...panel,
          widgets: panel.widgets.filter((widget) => section.widgetKinds.includes(widget.kind)),
        })),
    }));
  const sections = [
    {
      id: "overview",
      title: "总览",
      order: 0,
      showPositionSummary: false,
      panels: panels.map((panel) => ({
        ...panel,
        widgets: panel.widgets.filter((widget) => widget.kind === "quote-card"),
      })),
    },
    {
      id: "positions",
      title: "持仓",
      order: 5,
      showPositionSummary: false,
      panels: [portfolioPanel],
    },
    { id: "brokers", title: "券商", order: 6, showPositionSummary: false, panels: [brokersPanel] },
    { id: "research", title: "宏观研究与判断", order: 7, showPositionSummary: false, panels: [researchPanel] },
    { id: "trading-review", title: "交易复盘", order: 8, showPositionSummary: false, panels: [tradingReviewPanel] },
    ...assetSections,
    {
      id: "intel",
      title: "情报",
      order: 900,
      showPositionSummary: false,
      panels: [intelPanel],
    },
    { id: "settings", title: "设置", order: 905, showPositionSummary: false, panels: [settingsPanel] },
    {
      id: "system",
      title: "系统",
      order: 910,
      showPositionSummary: false,
      panels: [systemPanel],
    },
  ];
  return ViewDescriptorSchema.parse({
    viewId: "dashboard",
    title: "Investment monitor / 投资监控",
    layout,
    panels: allPanels,
    sections,
  });
}

function instrumentMatchesSection(
  instrument: InstrumentConfig,
  section: AppConfig["sections"][number],
): boolean {
  if (typeof instrument.metadata.dashboardSection === "string") return instrument.metadata.dashboardSection === section.id;
  const capabilities = new Set(instrument.sourceBindings.flatMap((binding) => binding.capabilities));
  return section.match.assetClasses.includes(instrument.assetClass)
    || section.match.capabilities.some((capability) => capabilities.has(capability));
}

function freshnessRank(status: Freshness["status"]): number {
  return { live: 0, delayed: 1, stale: 2, unavailable: 3 }[status];
}

function newsCapabilityAvailable(snapshot: ConfigSnapshot): boolean {
  return snapshot.config.intel.enabled && snapshot.config.intel.sources.some((sourceId) => {
    const source = snapshot.config.sources.find((candidate) => candidate.id === sourceId);
    return source?.enabled === true && source.adapter === "rss" && source.capabilities.includes("news");
  });
}

function configuredCandleTimeframe(binding: InstrumentConfig["sourceBindings"][number], snapshot: ConfigSnapshot): string {
  const source = snapshot.config.sources.find((candidate) => candidate.id === binding.sourceId);
  const value = binding.params.timeframe ?? binding.params.interval ?? source?.params.timeframe ?? source?.params.interval;
  return typeof value === "string" && ["1s", "1m", "5m", "15m", "1h", "1d", "1w"].includes(value)
    ? value
    : "1m";
}

async function publishSchedulerEvent(
  event: SchedulerEvent,
  deps: { configManager: ConfigManager; storage: StorageDriver; scheduler: CollectorScheduler; events: SseEventHub },
): Promise<void> {
  const snapshot = deps.configManager.snapshot;
  if (event.type === "quote.updated") {
    const instrument = snapshot.config.instruments.find((candidate) => candidate.id === event.instrumentId);
    if (!instrument) return;
    const envelope = (await quoteEnvelopes(instrument, snapshot, deps)).find((entry) => entry.sourceId === event.sourceId);
    deps.events.publish("quote.updated", event.generation, {
      instrumentId: event.instrumentId,
      sourceId: event.sourceId,
      quote: envelope?.quote ?? null,
      freshness: envelope?.freshness ?? null,
      quoteAsset: envelope?.quoteAsset ?? null,
      priority: envelope?.priority ?? null,
      egressProfile: envelope?.egressProfile ?? null,
      sourceHealth: envelope?.sourceHealth ?? null,
    });
    return;
  }

  const health = (await deps.storage.getLatestSourceHealth(event.sourceId, event.capability))[0] ?? event.health;
  const egressStatus = (await sourceEgressStatuses(snapshot, deps.storage, event.sourceId))[0] ?? null;
  const observations = await quoteObservations(deps.storage);
  const affectedQuotes = (await Promise.all(snapshot.config.instruments
    .filter((instrument) => instrument.active && instrument.sourceBindings.some((binding) => binding.sourceId === event.sourceId && binding.capabilities.includes(event.capability)))
    .map(async (instrument) => {
      const entries = await quoteEnvelopes(instrument, snapshot, deps, observations);
      return entries.filter((entry) => entry.sourceId === event.sourceId).map((entry) => ({
        instrumentId: instrument.id,
        sourceId: entry.sourceId,
        quote: entry.quote,
        freshness: entry.freshness,
        quoteAsset: entry.quoteAsset,
      }));
    }))).flat();
  deps.events.publish("health.updated", event.generation, {
    instrumentId: event.instrumentId,
    sourceId: event.sourceId,
    capability: event.capability,
    sourceHealth: health,
    egressStatus,
    affectedQuotes,
  });
}

interface SourceEgressStatus {
  readonly sourceId: string;
  readonly configuredPrimaryEgress: EgressName;
  readonly latestActualEgress: EgressName | null;
  readonly fallbackCount1h: number;
}

async function sourceEgressStatuses(
  snapshot: ConfigSnapshot,
  storage: StorageDriver,
  sourceId?: string,
): Promise<SourceEgressStatus[]> {
  const usage = await storage.getSourceEgressUsageSince(Date.now() - EGRESS_FALLBACK_WINDOW_MS);
  return snapshot.config.sources
    .filter((source) => !sourceId || source.id === sourceId)
    .map((source) => {
      const sourceUsage = usage.filter((entry) => entry.sourceId === source.id);
      const latest = sourceUsage
        .slice()
        .sort((left, right) => right.latestObservedAtMs - left.latestObservedAtMs)[0];
      return {
        sourceId: source.id,
        configuredPrimaryEgress: source.egressProfile,
        latestActualEgress: latest?.egressProfileUsed ?? null,
        fallbackCount1h: sourceUsage
          .filter((entry) => entry.egressProfileUsed !== source.egressProfile)
          .reduce((total, entry) => total + entry.requestCountSince, 0),
      };
    });
}

function handleSse(request: IncomingMessage, response: ServerResponse, events: SseEventHub): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders();
  response.write(": connected\n\n");
  const headerValue = request.headers["last-event-id"];
  const lastEventId = typeof headerValue === "string"
    ? headerValue
    : new URL(request.url ?? "/", "http://localhost").searchParams.get("lastEventId");
  const connection = events.connect(response, lastEventId);
  if (connection.historyGap) {
    const gapEvent = {
      id: connection.latestEventId,
      type: "health.updated" as const,
      generation: connection.latestGeneration,
      occurredAt: new Date().toISOString(),
      payload: { reason: "event-history-gap", restore: "REST snapshot required" },
    };
    writeEvent(response, gapEvent);
  }
  for (const event of connection.historyGap ? [] : connection.replay) writeEvent(response, event);
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
  }, 15_000);
  const close = () => {
    clearInterval(heartbeat);
    connection.close();
  };
  request.once("close", close);
  response.once("close", close);
}

async function runStartupClockSkewCheck(snapshot: ConfigSnapshot, httpClient: EgressHttpClient): Promise<void> {
  const sources = snapshot.config.sources.filter((source) => source.enabled).slice(0, 2);
  const signal = AbortSignal.timeout(8000);
  for (const source of sources) {
    if (signal.aborted) break;
    const egress = snapshot.config.egressProfiles[source.egressProfile];
    const response = await httpClient.request({
      url: source.baseUrl,
      egressProfile: source.egressProfile,
      egressFallback: source.egressFallback,
      userAgent: source.userAgent,
      followRedirects: source.followRedirects,
      maxRedirects: egress.maxRedirects,
      connectTimeoutMs: egress.connectTimeoutMs,
      requestTimeoutMs: egress.requestTimeoutMs,
      signal,
    });
    if (!response.ok || response.value.clockSkewMs === null) continue;

    const clockSkewMs = response.value.clockSkewMs;
    const fields = {
      level: "INFO",
      sourceId: source.id,
      egressProfile: source.egressProfile,
      egressFallback: source.egressFallback,
      clockSkewMs,
      clockSkewToleranceMs: snapshot.config.clockSkewToleranceMs,
      serverDate: response.value.serverDate,
    };
    if (Math.abs(clockSkewMs) > snapshot.config.clockSkewToleranceMs) {
      log("clock_skew.warning", {
        ...fields,
        level: "WARN",
        message: "local clock differs from provider Date; freshness uses receivedAt for suspected future timestamps; synchronize NTP",
      });
    } else {
      log("clock_skew.startup_check", fields);
    }
    return;
  }
  log("clock_skew.check_unavailable", {
    level: "WARN",
    message: "startup clock check could not obtain a Date header from an enabled source; freshness safeguards remain active",
  });
}

async function runEgressChecks(deps: { httpClient: EgressHttpClient; configManager: ConfigManager }) {
  const checksByProfile = {
    direct: [{ name: "federal-reserve", target: FEDERAL_RESERVE_URL, expectSuccess: true }],
    corp: [
      { name: "binance-vision", target: CORP_MARKET_PROBE_URL, expectSuccess: true },
      { name: "federal-reserve-isolation", target: FEDERAL_RESERVE_URL, expectSuccess: false },
    ],
    vpn: [{ name: "binance-ping", target: VPN_PROBE_URL, expectSuccess: true }],
  } as const;
  const config = deps.configManager.snapshot.config;
  const checks = await Promise.all((Object.keys(checksByProfile) as (keyof typeof checksByProfile)[]).map(async (profile) => {
    const egress = config.egressProfiles[profile];
    const listener = await checkProxyListener(egress.proxyUrl);
    const profileChecks = await Promise.all(checksByProfile[profile].map(async (targetSpec) => {
      const response = await deps.httpClient.request({
        url: targetSpec.target,
        egressProfile: profile,
        userAgent: egress.userAgent,
        followRedirects: egress.followRedirects,
        maxRedirects: egress.maxRedirects,
        connectTimeoutMs: egress.connectTimeoutMs,
        requestTimeoutMs: egress.requestTimeoutMs,
      });
      const requestSucceeded = response.ok && response.value.status >= 200 && response.value.status < 300;
      const checkOk = targetSpec.expectSuccess ? requestSucceeded : !requestSucceeded;
      return {
        name: targetSpec.name,
        target: targetSpec.target,
        expectation: targetSpec.expectSuccess ? "2xx" : "non-2xx-or-network-failure",
        ok: checkOk,
        status: response.ok ? response.value.status : null,
        error: response.ok
          ? requestSucceeded ? null : { kind: "http", message: `HTTP ${response.value.status}` }
          : response.error,
      };
    }));
    return {
      profile,
      proxyListener: listener,
      ok: listener.reachable && profileChecks.every((check) => check.ok),
      checks: profileChecks,
    };
  }));
  return { checkedAt: new Date().toISOString(), profiles: checks };
}

function applyEgressEnvironmentOverrides(config: AppConfig): AppConfig {
  const singleProxy = process.env.EGRESS_SINGLE_PROXY_URL?.trim();
  if (singleProxy) {
    const profiles = Object.fromEntries(Object.entries(config.egressProfiles).map(([name, profile]) => [name, EgressProfileSchema.parse({ ...profile, proxyUrl: singleProxy })]));
    return { ...config, egressProfiles: profiles as AppConfig["egressProfiles"],
      sources: config.sources.map(source => ({ ...source, egressFallback: [] })),
      instruments: config.instruments.map(instrument => ({ ...instrument, sourceBindings: instrument.sourceBindings.map(binding => ({ ...binding, egressFallback: [] })) })) };
  }
  const overrides = [
    ["direct", "EGRESS_DIRECT_PROXY_URL"],
    ["corp", "EGRESS_CORP_PROXY_URL"],
    ["vpn", "EGRESS_VPN_PROXY_URL"],
  ] as const;
  let changed = false;
  const egressProfiles = { ...config.egressProfiles };
  for (const [profileName, environmentName] of overrides) {
    const rawValue = process.env[environmentName];
    if (rawValue === undefined) continue;
    const proxyUrl = rawValue.trim() === "" ? null : rawValue.trim();
    const parsed = EgressProfileSchema.shape.proxyUrl.safeParse(proxyUrl);
    if (!parsed.success) throw new Error(`${environmentName} must be an HTTP(S) proxy URL or an empty string`);
    const current = egressProfiles[profileName];
    if (!current) throw new Error(`egress profile ${profileName} is missing from configuration`);
    egressProfiles[profileName] = { ...current, proxyUrl: parsed.data };
    changed = true;
  }
  return changed ? { ...config, egressProfiles } : config;
}

function loadAuthMode(): AuthMode {
  const configuredMode = (process.env.UI_AUTH_MODE ?? (process.env.NODE_ENV === "production" ? "password" : "off")).trim().toLowerCase();
  if (configuredMode === "off" || configuredMode === "password" || configuredMode === "token") return configuredMode;
  throw new Error(`unsupported UI_AUTH_MODE: ${configuredMode}`);
}

async function loadAuthToken(authMode: AuthMode): Promise<string | null> {
  if (authMode === "off") return null;
  const tokenFile = process.env.UI_AUTH_TOKEN_FILE?.trim();
  if (tokenFile) {
    let token: string;
    try {
      token = (await readFile(tokenFile, "utf8")).trim();
    } catch {
      throw new Error("token authentication is enabled but UI_AUTH_TOKEN_FILE cannot be read");
    }
    if (!token) throw new Error("token authentication is enabled but UI_AUTH_TOKEN_FILE is empty");
    return token;
  }

  const token = (process.env.UI_AUTH_TOKEN ?? process.env.API_AUTH_TOKEN ?? "").trim();
  if (!token && authMode === "token") throw new Error("token authentication is enabled but no UI auth token is configured");
  return token || null;
}

async function ensurePasswordCredential(storage: StorageDriver): Promise<StoredPasswordCredential> {
  const existing = await storage.getPasswordCredential();
  if (existing) return existing;

  const initial = await hashPassword(DEFAULT_INITIAL_PASSWORD);
  await storage.initializePasswordCredential({
    passwordHash: initial.passwordHash,
    passwordSalt: initial.passwordSalt,
    isInitial: true,
    updatedAtMs: Date.now(),
  });
  const initialized = await storage.getPasswordCredential();
  if (!initialized) throw new Error("password credential could not be initialized");
  return initialized;
}

async function hashPassword(password: string): Promise<{ passwordHash: string; passwordSalt: string }> {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const derivedKey = await derivePasswordKey(password, salt);
  return {
    passwordHash: derivedKey.toString("hex"),
    passwordSalt: salt.toString("hex"),
  };
}

async function verifyPassword(password: string, credential: StoredPasswordCredential): Promise<boolean> {
  const salt = parseHexBuffer(credential.passwordSalt, PASSWORD_SALT_BYTES) ?? Buffer.alloc(PASSWORD_SALT_BYTES);
  const expected = parseHexBuffer(credential.passwordHash, PASSWORD_KEY_BYTES) ?? Buffer.alloc(PASSWORD_KEY_BYTES);
  const storedCredentialIsWellFormed = parseHexBuffer(credential.passwordSalt, PASSWORD_SALT_BYTES) !== null
    && parseHexBuffer(credential.passwordHash, PASSWORD_KEY_BYTES) !== null;
  const derivedKey = await derivePasswordKey(password, salt);
  const matches = timingSafeEqual(derivedKey, expected);
  return storedCredentialIsWellFormed && matches;
}

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      PASSWORD_SCRYPT_OPTIONS,
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePromise(derivedKey);
      },
    );
  });
}

function parseHexBuffer(value: string, byteLength: number): Buffer | null {
  const pattern = new RegExp(`^[0-9a-f]{${byteLength * 2}}$`, "i");
  return pattern.test(value) ? Buffer.from(value, "hex") : null;
}

class SessionStore {
  private readonly sessions = new Map<string, number>();

  public constructor(private readonly ttlMs: number) {}

  public create(): string {
    this.prune();
    const sessionId = randomBytes(32).toString("base64url");
    this.sessions.set(sessionId, Date.now() + this.ttlMs);
    return sessionId;
  }

  public isValid(sessionId: string): boolean {
    const expiresAtMs = this.sessions.get(sessionId);
    if (expiresAtMs === undefined) return false;
    if (expiresAtMs <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  public revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  public revokeAllExcept(sessionId: string | null): void {
    for (const candidate of this.sessions.keys()) {
      if (candidate !== sessionId) this.sessions.delete(candidate);
    }
  }

  private prune(): void {
    const nowMs = Date.now();
    for (const [sessionId, expiresAtMs] of this.sessions) {
      if (expiresAtMs <= nowMs) this.sessions.delete(sessionId);
    }
  }
}

class LoginRateLimiter {
  private readonly states = new Map<string, LoginRateState>();

  public retryAfterMs(key: string): number {
    const state = this.states.get(key);
    if (!state) return 0;
    const nowMs = Date.now();
    this.prune(state, nowMs);
    if (state.blockedUntilMs <= nowMs) {
      state.blockedUntilMs = 0;
      return 0;
    }
    return state.blockedUntilMs - nowMs;
  }

  public recordFailure(key: string): number {
    const nowMs = Date.now();
    const state = this.states.get(key) ?? { failures: [], blockedUntilMs: 0 };
    this.prune(state, nowMs);
    state.failures.push(nowMs);
    let retryAfterMs = 0;
    if (state.failures.length >= LOGIN_FAILURE_LIMIT) {
      const exponent = state.failures.length - LOGIN_FAILURE_LIMIT;
      const backoffMs = Math.min(LOGIN_MAX_BACKOFF_MS, LOGIN_INITIAL_BACKOFF_MS * (2 ** exponent));
      state.blockedUntilMs = nowMs + backoffMs;
      retryAfterMs = backoffMs;
    }
    this.states.set(key, state);
    return retryAfterMs;
  }

  public recordSuccess(key: string): void {
    this.states.delete(key);
  }

  private prune(state: LoginRateState, nowMs: number): void {
    state.failures = state.failures.filter((failureAtMs) => failureAtMs > nowMs - LOGIN_WINDOW_MS);
  }
}

interface LoginRateState {
  failures: number[];
  blockedUntilMs: number;
}

function loadBooleanEnvironment(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name];
  if (rawValue === undefined) return fallback;
  const normalized = rawValue.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  throw new Error(`${name} must be true or false`);
}

function loadSessionTtlMs(): number {
  const rawValue = process.env.UI_AUTH_SESSION_TTL_SECONDS;
  if (rawValue === undefined || rawValue.trim() === "") return DEFAULT_SESSION_TTL_MS;
  const seconds = Number(rawValue);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error("UI_AUTH_SESSION_TTL_SECONDS must be a positive integer");
  }
  return seconds * 1000;
}

async function resolveAuthReference(authRef: string | null): Promise<string | null> {
  if (authRef === null) return null;
  const match = /^(env|secret):([A-Z][A-Z0-9_]*)$/.exec(authRef);
  if (!match) return null;
  const [, scheme, name] = match;
  if (!name) return null;
  if (scheme === "env") return nonEmptyEnvironment(name);

  const environmentValue = nonEmptyEnvironment(name);
  if (environmentValue) return environmentValue;
  const fileOverride = nonEmptyEnvironment(`${name}_FILE`);
  const candidates = fileOverride
    ? [fileOverride]
    : [`/run/secrets/${name}`, `/run/secrets/${name.toLowerCase()}`];
  for (const path of candidates) {
    try {
      const value = (await readFile(path, "utf8")).trim();
      if (value) return value;
    } catch {
      // Missing or unreadable secret files make only this source unavailable.
    }
  }
  return null;
}

// Settings saved from the page override the process environment for every credential reference.
let runtimeSettings: SettingsService | null = null;
function nonEmptyEnvironment(name: string): string | null {
  const value = (runtimeSettings?.env()[name] ?? process.env[name])?.trim();
  return value ? value : null;
}

function safeConfig(snapshot: ConfigSnapshot, scheduler: CollectorScheduler, intel: IntelScheduler) {
  return {
    generation: snapshot.generation,
    sha256: snapshot.sha256,
    loadedAt: snapshot.loadedAt,
    issues: snapshot.issues ?? [],
    clockSkewToleranceMs: snapshot.config.clockSkewToleranceMs,
    egressProfiles: snapshot.config.egressProfiles,
    instruments: snapshot.config.instruments,
    sources: snapshot.config.sources.map((source) => ({
      id: source.id,
      adapter: source.adapter,
      baseUrl: source.baseUrl,
      egressProfile: source.egressProfile,
      egressFallback: source.egressFallback,
      userAgent: source.userAgent,
      followRedirects: source.followRedirects,
      capabilities: source.capabilities,
      defaultBinding: source.defaultBinding,
      params: source.params,
      rateLimit: source.rateLimit,
      enabled: source.enabled,
      authConfigured: source.authRef !== null && scheduler.sourceAuthConfigured(source.id),
    })),
    symbolMaps: snapshot.config.symbolMaps,
    sections: snapshot.config.sections,
    intel: snapshot.config.intel,
    llm: {
      providers: snapshot.config.llm.providers.map((provider) => ({
        id: provider.id,
        baseUrl: provider.baseUrl,
        egressProfile: provider.egressProfile,
        egressFallback: provider.egressFallback,
        models: provider.models,
        enabled: provider.enabled,
        authConfigured: intel.providerAuthConfigured(provider.id),
      })),
      routes: snapshot.config.llm.routes,
    },
    accounts: snapshot.config.accounts.map((account) => ({ ...account, credentialsRef: account.credentialsRef !== null })),
  };
}

/** One provider handle for the inference service; `swap()` rebuilds it after the LLM settings change. */
function switchableDailyLlmProvider(factory: () => DailyLlmProvider): DailyLlmProvider & { swap(): void } {
  let current = factory();
  return {
    status: () => current.status(),
    complete: (system, user, signal, options) => current.complete(system, user, signal, options),
    checkConnection: () => current.checkConnection ? current.checkConnection() : Promise.reject(new Error("此provider未提供连接检测。")),
    close: () => current.close?.() ?? Promise.resolve(),
    swap() { const previous = current; current = factory(); void previous.close?.().catch(() => undefined); },
  };
}

async function settingsStatuses(deps: HttpDependencies): Promise<Partial<Record<SettingsGroupId, SettingsGroupStatus | null>>> {
  const out: Partial<Record<SettingsGroupId, SettingsGroupStatus | null>> = { network: null };
  const workspace = await brokerWorkspaceData(deps.storage, deps.configManager?.snapshot.config, deps.settings?.env());
  for (const c of workspace.connections) {
    const s = c.sync;
    out[c.id] = !c.configured ? { state: "unconfigured", message: c.missing.length ? `缺少 ${c.missing.join("、")}` : null, checkedAt: null }
      : c.authorization?.needsReauthorization ? { state: "reauthorize", message: c.authorization.message ?? "刷新令牌已过期，请重新授权", checkedAt: c.authorization.issuedAt }
      : s?.state === "running" ? { state: "running", message: "正在同步", checkedAt: s.startedAt }
      : s?.state === "error" ? { state: "error", message: s.message, checkedAt: s.completedAt }
      : s?.state === "success" ? { state: "ok", message: `最近同步成功：${s.accounts} 个账户 · ${s.positions} 项持仓 · ${s.trades} 笔成交`, checkedAt: s.completedAt, details: { accounts: s.accounts, positions: s.positions, trades: s.trades, cadenceMinutes: c.cadenceMinutes ?? null } }
      : { state: "never", message: "已配置，尚未同步", checkedAt: null };
  }
  const llm = deps.dailyLlm?.status();
  out.llm = !llm ? null : !llm.configured ? { state: "unconfigured", message: llm.issue ?? (llm.missing.length ? `缺少 ${llm.missing.join("、")}` : null), checkedAt: null }
    : llm.connection?.selected ? { state: "ok", message: `已选择出口 ${llm.connection.selected}`, checkedAt: llm.connection.checkedAt ?? null, details: { provider: llm.provider, model: llm.model } }
    : { state: "never", message: "已配置，尚未检测连接", checkedAt: null, details: { provider: llm.provider, model: llm.model } };
  return out;
}

async function settingsTest(group: SettingsGroupId, env: NodeJS.ProcessEnv, deps: HttpDependencies): Promise<SettingsTestResult> {
  if (group === "llm") {
    if (!deps.dailyLlm?.checkConnection) return { ok: false, message: "当前 provider 不支持连接检测。" };
    const connection = await deps.dailyLlm.checkConnection();
    const probes = Object.fromEntries((connection.probes ?? []).map(p => [p.profile, `${p.successes}/${p.attempts} 成功${p.medianMs != null ? ` · ${p.medianMs} ms` : ""}${p.modelAvailable === false ? " · 模型不可用" : ""}${p.issue ? ` · ${p.issue}` : ""}`]));
    return { ok: !!connection.selected, message: connection.selected ? `连接成功，选择出口 ${connection.selected}` : connection.note || "未找到可用出口，请检查 API 地址、Key 和模型。", details: probes };
  }
  if (group === "network") return { ok: false, message: "网络出口无需检测；保存后下次券商同步生效。" };
  return probeBroker(group, env);
}

function configDiff(previous: ConfigSnapshot["config"], next: ConfigSnapshot["config"]) {
  const previousInstruments = new Set(previous.instruments.map((instrument) => instrument.id));
  const nextInstruments = new Set(next.instruments.map((instrument) => instrument.id));
  const previousSources = new Set(previous.sources.map((source) => source.id));
  const nextSources = new Set(next.sources.map((source) => source.id));
  return {
    addedInstruments: [...nextInstruments].filter((id) => !previousInstruments.has(id)),
    removedInstruments: [...previousInstruments].filter((id) => !nextInstruments.has(id)),
    addedSources: [...nextSources].filter((id) => !previousSources.has(id)),
    removedSources: [...previousSources].filter((id) => !nextSources.has(id)),
  };
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonOrNull(value: string | null): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(body);
}

function historyRange(url: URL): { before: number; from: number } | null {
  const parse = (key: string, fallback: number) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    return /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  };
  const before = parse("before", Number.MAX_SAFE_INTEGER), from = parse("from", 0);
  return Number.isSafeInteger(before) && Number.isSafeInteger(from) && from >= 0 && before > from ? { before, from } : null;
}

function log(event: string, fields: Record<string, unknown>): void {
  serviceLog(event, fields);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
