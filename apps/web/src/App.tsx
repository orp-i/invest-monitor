import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  changePassword,
  createInstrument,
  createSession,
  deleteInstrument,
  isServerEvent,
  loadSnapshot,
  probeInstruments,
  searchInstruments,
  sessionIsValid,
  sessionStatus,
} from "./api";
import { FreshnessBadge } from "./FreshnessBadge";
import { invalidateChartSource } from "./useChartData";
import { formatDecimal, formatTimestamp, statusLabel, statusIcon } from "./format";
import type {
  ConnectionState,
  Freshness,
  InstrumentCandidate,
  InstrumentProbeEvidence,
  InstrumentSearchResponse,
  NewsItem,
  PnlSummary,
  QuoteEnvelope,
  ServerEvent,
  Snapshot,
  SourceEgressStatus,
  SourceHealth,
} from "./types";
import { WidgetRenderer } from "./widgets";
import { Overview, MarketSelector } from "./Overview";
import { useWebUpdate } from "./useWebUpdate";
import { AllBrokerPositions } from "./AllBrokerPositions";
import { MarketInterest } from "./MarketInterest";
import { aggregateStatus, panelStatus } from "./dashboard";
import { navigateRoute, replaceRoute, useRoute } from "./route";
import { LiveClock } from "./useNow";
import "./styles.css";

const SSE_EVENT_TYPES = ["quote.updated", "health.updated", "candle.updated", "news.created", "pnl.updated"];

export default function App() {
  const webUpdate = useWebUpdate();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [usingInitialPassword, setUsingInitialPassword] = useState(false);
  const [showInstrumentManager, setShowInstrumentManager] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  // Coarse shared clock for freshness thresholds; elapsed-time labels tick locally (see useNow).
  const [nowMs, setNowMs] = useState(() => Date.now());
  const route = useRoute();
  const activeSectionId = route.section;
  const reloadRequestedGeneration = useRef(0);
  const snapshotRefreshTimer = useRef<number | null>(null);
  const snapshotRefreshPending = useRef(false);
  const reloadInFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!snapshot) return;
    const sections = snapshot.view.sections;
    if (sections.some((section) => section.id === activeSectionId)) return;
    const fallback = sections.find((section) => section.id === "overview")?.id ?? sections[0]?.id ?? "";
    if (fallback) replaceRoute(fallback);
  }, [activeSectionId, snapshot]);
  useEffect(() => {
    const tab = document.getElementById(`tab-${activeSectionId}`), nav = tab?.parentElement;
    if (!tab || !nav) return;
    const left = tab.offsetLeft - nav.offsetLeft, right = left + tab.offsetWidth;
    if (left < nav.scrollLeft || right > nav.scrollLeft + nav.clientWidth) nav.scrollTo({ left: Math.max(0, left - 16), behavior: "smooth" });
  }, [activeSectionId, snapshot]);

  const requireUnlock = useCallback((message: string | null = null) => {
    setSnapshot(null);
    setAuthenticated(false);
    setUsingInitialPassword(false);
    setShowPasswordForm(false);
    setPasswordNotice(null);
    setAuthRequired(true);
    setLoading(false);
    setUnlockError(message);
  }, []);

  const reload = useCallback(() => {
    if (reloadInFlight.current) return reloadInFlight.current;
    reloadInFlight.current = (async () => {
    try {
      const session = await sessionStatus();
      if (!session) throw new ApiError(401, "/api/session", "Unauthorized", "unauthorized");
      const next = await loadSnapshot();
      setSnapshot((current) => current ? mergeSnapshots(current, next) : next);
      setAuthenticated(true);
      setUsingInitialPassword(session.usingInitialPassword === true);
      setAuthRequired(false);
      setError(null);
      setUnlockError(null);
    } catch (reason: unknown) {
      if (isUnauthorizedError(reason)) {
        requireUnlock();
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setLoading(false);
    }
    })().finally(() => { reloadInFlight.current = null; });
    return reloadInFlight.current;
  }, [requireUnlock]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const scheduleSnapshotRefresh = useCallback(function schedule() {
    if (document.hidden) return;
    snapshotRefreshPending.current = true;
    if (snapshotRefreshTimer.current !== null) return;
    snapshotRefreshTimer.current = window.setTimeout(() => {
      // Reconnect recovery only. Quote events already carry the changed rows.
      snapshotRefreshPending.current = false;
      void reload().finally(() => {
        snapshotRefreshTimer.current = null;
        if (snapshotRefreshPending.current) schedule();
      });
    }, 500);
  }, [reload]);
  useEffect(() => {
    if (!authenticated) return;
    const refresh = () => { if (!document.hidden) void reload(); };
    const timer = window.setInterval(refresh, 60000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [authenticated, reload]);
  useEffect(() => () => {
    if (snapshotRefreshTimer.current !== null) window.clearTimeout(snapshotRefreshTimer.current);
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    if (event.type === "pnl.updated") window.dispatchEvent(new Event("invest:broker-data-updated"));
    if (event.type === "health.updated" && event.payload.capability === "candle" && typeof event.payload.sourceId === "string") invalidateChartSource(event.payload.sourceId, typeof event.payload.instrumentId === "string" ? event.payload.instrumentId : undefined);
    // Apply SSE deltas directly. Portfolio valuation has its own refresh, and
    // the minute refresh reconciles manual subtotals and cross-tab changes.
    setSnapshot((current) => {
      if (!current || event.generation < current.generation) return current;
      const reason = event.payload.reason;
      if (event.generation > current.generation || reason === "config-reloaded") {
        if (event.generation > reloadRequestedGeneration.current) {
          reloadRequestedGeneration.current = event.generation;
          void reload().finally(() => {
            if (reloadRequestedGeneration.current === event.generation) reloadRequestedGeneration.current = 0;
          });
        }
        return current;
      }
      if (event.type === "quote.updated") return applyQuoteEvent(current, event.payload);
      if (event.type === "health.updated") return applyHealthEvent(current, event.payload);
      if (event.type === "news.created") return applyNewsEvent(current, event.payload);
      return current;
    });
  }, [reload]);

  const login = useCallback(async (password: string) => {
    setUnlockError(null);
    try {
      const session = await createSession(password);
      setUsingInitialPassword(session.usingInitialPassword === true);
      await reload();
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 429) {
        setUnlockError("尝试过于频繁，请稍后再试。");
      } else if (isUnauthorizedError(reason)) {
        setUnlockError("密码错误，请重试。");
      } else {
        setUnlockError(reason instanceof Error ? reason.message : String(reason));
      }
    }
  }, [reload]);

  const submitPasswordChange = useCallback(async (currentPassword: string, newPassword: string) => {
    await changePassword(currentPassword, newPassword);
    setUsingInitialPassword(false);
    setShowPasswordForm(false);
    setPasswordNotice("密码修改成功，当前会话仍然有效。");
  }, []);

  const handleStreamUnauthorized = useCallback(() => {
    requireUnlock("会话已失效，请重新输入密码。");
  }, [requireUnlock]);

  const connectionState = useEventStream(
    handleServerEvent,
    authenticated,
    handleStreamUnauthorized,
    scheduleSnapshotRefresh,
  );

  if (authRequired) {
    return <LoginScreen error={unlockError} onSubmit={login} />;
  }

  if (!snapshot && loading) {
    return <AppShell connectionState={connectionState}><LoadingState message="正在载入投资复盘工具…" /></AppShell>;
  }
  if (!snapshot) {
    return <AppShell connectionState={connectionState}><LoadingState message={`看板暂不可用：${error ?? "unknown error"}`} error /></AppShell>;
  }

  const sections = snapshot.view.sections.length > 0
    ? [...snapshot.view.sections].sort((left, right) => left.order - right.order)
    : [{ id: "all", title: snapshot.view.title, order: 0, showPositionSummary: false, panels: snapshot.view.panels }];
  const activeSection = sections.find((section) => section.id === activeSectionId) ?? sections[0];

  const navigate = (id: string) => navigateRoute(id);
  const selectedPanel = activeSection?.panels.find(panel => panel.instrumentId === route.rest[0]) ?? activeSection?.panels[0];
  const visiblePanels = activeSection?.showPositionSummary && selectedPanel ? [selectedPanel] : activeSection?.panels ?? [];

  return (
    <AppShell connectionState={connectionState}>
      <MarketInterest instrumentId={activeSection?.showPositionSummary ? selectedPanel?.instrumentId ?? null : null} />
      <header className="hero">
        <div className="brand-heading">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <div><p className="eyebrow">INVEST / PERSONAL REVIEW</p><h1>投资复盘</h1><p className="hero-copy">看清整体盈亏，理解市场变化，检验每一次判断。</p></div>
        </div>
        <div className="hero-meta">
          <span><LiveClock format={now => formatTimestamp(new Date(now).toISOString())} /></span>
          <div className="hero-actions">
            <button className="secondary-button" type="button" disabled={refreshing} onClick={() => { setRefreshing(true); void Promise.all([reload(), webUpdate.check()]).finally(() => setRefreshing(false)); }}>{refreshing ? "刷新中…" : "↻ 刷新"}</button>
            <button className="secondary-button" type="button" aria-expanded={showInstrumentManager} onClick={() => setShowInstrumentManager(value => !value)}>＋ 添加标的</button>
            <button className="secondary-button" type="button" aria-expanded={showPasswordForm} onClick={() => { setPasswordNotice(null); setShowPasswordForm(value => !value); }}>账户设置</button>
          </div>
        </div>
      </header>
      {webUpdate.available && <div className="web-update-notice" role="status"><div><strong>网页有新版本</strong><p>请先保存正在填写的内容，再重新加载以使用最新功能。</p></div><button className="primary-button" onClick={() => window.location.reload()}>重新加载页面</button></div>}
      {usingInitialPassword ? (
        <div className="password-warning" role="alert">
          <span aria-hidden="true">!</span>
          <div>
            <strong>当前仍在使用初始密码</strong>
            <p>为降低同一网络内其他设备猜测密码的风险，请尽快设置新密码。</p>
          </div>
          <button
            className="warning-button"
            type="button"
            onClick={() => {
              setPasswordNotice(null);
              setShowPasswordForm(true);
            }}
          >
            立即修改
          </button>
        </div>
      ) : null}
      {passwordNotice ? <div className="password-success" role="status">✓ {passwordNotice}</div> : null}
      {showPasswordForm ? <PasswordChangeForm onCancel={() => setShowPasswordForm(false)} onSubmit={submitPasswordChange} /> : null}
      {showInstrumentManager ? <InstrumentManager onChanged={reload} /> : null}
      {error ? <div className="inline-error" role="alert">数据刷新失败：{error}</div> : null}
      <nav className="section-tabs" role="tablist" aria-label="投资复盘板块">
        {sections.map((section) => (
          <button
            key={section.id}
            id={`tab-${section.id}`}
            type="button"
            role="tab"
            aria-selected={section.id === activeSection?.id}
            aria-controls={`section-${section.id}`}
            tabIndex={section.id === activeSection?.id ? 0 : -1}
            onClick={() => navigate(section.id)}
            onKeyDown={(event) => {
              const index = sections.findIndex(item => item.id === section.id);
              const target = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index - 1 + sections.length) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : -1;
              if (target < 0) return;
              event.preventDefault();
              navigate(sections[target].id);
              document.getElementById(`tab-${sections[target].id}`)?.focus();
            }}
          >
            {section.title}{section.showPositionSummary ? <><span>{section.panels.length}</span><i className={`dot dot--${aggregateStatus(section.panels.map(panel => panelStatus(panel, snapshot, connectionState, nowMs)))}`} aria-label={statusLabel(aggregateStatus(section.panels.map(panel => panelStatus(panel, snapshot, connectionState, nowMs))))} /></> : null}
          </button>
        ))}
      </nav>
      {activeSection ? (
          <section
            className="dashboard-section"
            key={activeSection.id}
            id={`section-${activeSection.id}`}
            role="tabpanel"
            aria-labelledby={`tab-${activeSection.id}`}
          >
            <header className="section-header">
              <h2>{activeSection.title}</h2><span>{activeSection.id === "overview" ? "你的市场与账户，一目了然" : activeSection.showPositionSummary ? `${activeSection.panels.length} 个标的 · 点击切换详情` : ""}</span>
            </header>
            {activeSection.showPositionSummary ? (
              <SectionPositionSummary summary={snapshot.pnlSummary.sectionSummaries[activeSection.id]} />
            ) : null}
            {activeSection.panels.length === 0 ? (
              <div className="section-empty"><strong>当前板块未启用</strong><span>添加标的并启用相应数据源后即可查看。</span></div>
            ) : null}
            {activeSection.id === "overview" ? <Overview snapshot={snapshot} connectionState={connectionState} nowMs={nowMs} onNavigate={navigate} /> : <>
            {activeSection.showPositionSummary && selectedPanel ? <MarketSelector panels={activeSection.panels} selectedId={selectedPanel.instrumentId} onSelect={id => replaceRoute(activeSection.id, id)} snapshot={snapshot} connectionState={connectionState} nowMs={nowMs} /> : null}
            <div className="dashboard-grid">
              {visiblePanels.map((panel) => (
                <PanelView
                  key={`${activeSection.id}:${panel.panelId}:${panel.instrumentId}`}
                  panel={panel}
                  snapshot={snapshot}
                  connectionState={connectionState}
                  nowMs={nowMs}
                  onChanged={reload}
                />
              ))}
            </div>
            </>}
          </section>
      ) : null}
      <footer className="footer-note">
        INVEST · 原币核算 · 数据自动更新 <span>配置版本 {snapshot.generation}</span>
      </footer>
    </AppShell>
  );
}

function SectionPositionSummary({ summary }: { summary: Omit<PnlSummary, "sectionSummaries"> | undefined }): React.ReactNode {
  if (!summary || summary.positionsCount === 0) return null;
  return (
    <aside className="position-summary-band" aria-label="板块持仓摘要">
      <div><span>成本</span>{summary.costSubtotals.map((subtotal) => <strong className="numeric" key={subtotal.currency}>{formatDecimal(subtotal.costBasis, 2)} {subtotal.currency}</strong>)}</div>
      <div><span>市值</span>{summary.valuationSubtotals.map((subtotal) => <strong className="numeric" key={subtotal.currency}>{formatDecimal(subtotal.marketValue, 2)} {subtotal.marketValue === null ? "" : subtotal.currency}</strong>)}</div>
      <div><span>未实现盈亏</span>{summary.valuationSubtotals.map((subtotal) => <strong className="numeric" key={subtotal.currency}>{formatDecimal(subtotal.unrealizedPnl, 2)} {subtotal.unrealizedPnl === null ? "" : subtotal.currency}</strong>)}</div>
      <div><span>占比</span>{summary.valuationSubtotals.map((subtotal) => <strong className="numeric" key={subtotal.currency}>{formatDecimal(subtotal.allocationPercent, 2)}{subtotal.allocationPercent === null ? "" : `%（${subtotal.currency}）`}</strong>)}</div>
      {summary.explanation ? <p>{summary.explanation}</p> : null}
    </aside>
  );
}

function InstrumentManager({ onChanged }: { onChanged: () => Promise<void> }): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<InstrumentSearchResponse | null>(null);
  const [selected, setSelected] = useState<InstrumentCandidate[]>([]);
  const [probes, setProbes] = useState<InstrumentProbeEvidence[]>([]);
  const [busy, setBusy] = useState<"search" | "probe" | "create" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [managerError, setManagerError] = useState<string | null>(null);

  const search = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!query.trim() || busy) return;
    setBusy("search");
    setManagerError(null);
    setNotice(null);
    setSelected([]);
    setProbes([]);
    try {
      setResults(await searchInstruments(query.trim()));
    } catch (reason: unknown) {
      setManagerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const probeGroup = async (candidates: InstrumentCandidate[]) => {
    if (busy) return;
    setBusy("probe");
    setSelected(candidates);
    setProbes([]);
    setNotice(null);
    setManagerError(null);
    try {
      const response = await probeInstruments(candidates);
      setProbes(response.probes);
    } catch (reason: unknown) {
      setManagerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  const confirm = async () => {
    if (busy || selected.length === 0 || !probes.some((probe) => probe.ok)) return;
    setBusy("create");
    setManagerError(null);
    try {
      const created = await createInstrument(selected);
      setNotice(`已添加 ${created.instrument?.displayName ?? selected[0]?.baseAsset ?? "标的"}；服务端已完成二次探测。`);
      setResults(null);
      setSelected([]);
      setProbes([]);
      setQuery("");
      await onChanged();
    } catch (reason: unknown) {
      setManagerError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="instrument-manager" aria-labelledby="instrument-manager-title">
      <div className="instrument-manager-heading">
        <div>
          <p className="eyebrow">WATCHLIST</p>
          <h2 id="instrument-manager-title">自由添加标的</h2>
          <p>搜索名称或代码，验证数据源后加入关注列表。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "搜索并添加"}
        </button>
      </div>
      {open ? (
        <div className="instrument-manager-body">
          <form className="instrument-search-form" onSubmit={search}>
            <label htmlFor="instrument-search">名称或符号</label>
            <div>
              <input
                id="instrument-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="例如 doge、XAG、AAPL"
                maxLength={100}
              />
              <button type="submit" disabled={!query.trim() || busy !== null}>
                {busy === "search" ? "搜索中…" : "搜索"}
              </button>
            </div>
          </form>
          {results ? (
            <div className="instrument-search-results">
              {results.sources.filter((source) => !source.available).map((source) => (
                <div className="source-unavailable" key={source.sourceId} role="status">
                  <strong>{source.sourceId} · 未启用</strong>
                  <span>{source.unavailableReason?.message ?? "搜索不可用"}</span>
                  {source.unavailableReason?.steps.length ? (
                    <ol>{source.unavailableReason.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  ) : null}
                </div>
              ))}
              {results.groups.length === 0 ? <p className="empty-state">没有匹配候选。</p> : null}
              {results.groups.map((group) => (
                <article className="candidate-group" key={group.baseAsset}>
                  <header>
                    <div>
                      <strong>{group.baseAsset}</strong>
                      <span>{group.candidates.map((candidate) => candidate.sourceId).filter((value, index, values) => values.indexOf(value) === index).join(" + ")}</span>
                    </div>
                    <button type="button" disabled={busy !== null} onClick={() => void probeGroup(group.candidates)}>
                      探测后添加
                    </button>
                  </header>
                  <div className="candidate-bindings">
                    {group.candidates.map((candidate) => (
                      <span key={`${candidate.sourceId}:${candidate.providerSymbol}`}>
                        {candidate.sourceId} · {candidate.symbol} · quoteAsset <strong>{candidate.quoteAsset}</strong>
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
          {probes.length > 0 ? (
            <div className="probe-confirmation" aria-live="polite">
              <h3>真实探测证据</h3>
              <div className="probe-grid">
                {probes.map((probe) => (
                  <article className={`probe-row probe-row--${probe.ok ? "ok" : "failed"}`} key={`${probe.candidate.sourceId}:${probe.candidate.providerSymbol}`}>
                    <div>
                      <strong>{probe.candidate.sourceId}</strong>
                      <span>{probe.candidate.symbol}</span>
                    </div>
                    {probe.ok ? (
                      <dl>
                        <div><dt>真实价格</dt><dd className="numeric">{probe.price} {probe.quoteAsset}</dd></div>
                        <div><dt>采集时间</dt><dd>{probe.capturedAt ? formatTimestamp(probe.capturedAt) : "—"}</dd></div>
                        <div><dt>实际出口</dt><dd>{probe.egressUsed ?? "—"}</dd></div>
                        <div><dt>延迟</dt><dd className="numeric">{probe.latencyMs} ms</dd></div>
                      </dl>
                    ) : (
                      <p>{probe.error?.message ?? probe.error?.code ?? "探测失败"}</p>
                    )}
                  </article>
                ))}
              </div>
              <button className="confirm-instrument" type="button" disabled={busy !== null || !probes.some((probe) => probe.ok)} onClick={() => void confirm()}>
                {busy === "create" ? "服务端二次探测中…" : "确认保存已探测标的"}
              </button>
              <p className="probe-note">保存时服务端会独立重新探测；本页结果不会被当作可信凭据。</p>
            </div>
          ) : null}
          {notice ? <p className="instrument-notice" role="status">✓ {notice}</p> : null}
          {managerError ? <p className="auth-error" role="alert">{managerError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function LoginScreen({ error, onSubmit }: { error: string | null; onSubmit: (password: string) => Promise<void> }): React.ReactNode {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(password);
    } finally {
      setPassword("");
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="unlock-title">
        <p className="eyebrow">private investment monitor</p>
        <h1 id="unlock-title">登录投资复盘</h1>
        <p className="auth-copy">你的市场观察、交易记录与投资判断，集中在这里。</p>
        <form onSubmit={submit}>
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            spellCheck={false}
            autoFocus
            disabled={submitting}
          />
          <button type="submit" disabled={!password || submitting}>
            {submitting ? "登录中…" : "登录"}
          </button>
        </form>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
      </section>
    </main>
  );
}

function PasswordChangeForm({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
}): React.ReactNode {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    if (newPassword.length < 6) {
      setError("新密码至少 6 位。");
      return;
    }
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致。");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(currentPassword, newPassword);
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError("当前密码错误，请重新输入。");
      } else if (reason instanceof ApiError && reason.status === 400) {
        setError(reason.message);
      } else {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSubmitting(false);
    }
  };

  return (
    <section className="password-card" aria-labelledby="password-change-title">
      <div>
        <p className="eyebrow">account security</p>
        <h2 id="password-change-title">修改密码 / Change password</h2>
        <p className="password-copy">需要输入当前密码；成功后其他已打开的会话会失效。</p>
      </div>
      <form className="password-form" onSubmit={submit}>
        <label htmlFor="current-password">当前密码 / Current password</label>
        <input
          id="current-password"
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
          autoComplete="current-password"
          disabled={submitting}
        />
        <label htmlFor="new-password">新密码 / New password</label>
        <input
          id="new-password"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
          autoComplete="new-password"
          minLength={6}
          disabled={submitting}
        />
        <label htmlFor="confirm-password">确认新密码 / Confirm new password</label>
        <input
          id="confirm-password"
          type="password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          autoComplete="new-password"
          minLength={6}
          disabled={submitting}
        />
        <div className="password-actions">
          <button className="secondary-button" type="button" onClick={onCancel} disabled={submitting}>取消</button>
          <button type="submit" disabled={submitting || !currentPassword || !newPassword || !confirmation}>
            {submitting ? "保存中…" : "保存新密码"}
          </button>
        </div>
      </form>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
    </section>
  );
}

function AppShell({ children, connectionState }: { children: React.ReactNode; connectionState: ConnectionState }): React.ReactNode {
  return (
    <div className="app-shell">
      <div className={`stream-banner stream-banner--${connectionState}`} role="status">
        <span className="stream-pulse" aria-hidden="true" />
        <strong>{connectionLabel(connectionState)}</strong>
        <span>
          {connectionState === "connected"
            ? "行情与数据源状态自动更新"
            : "连接恢复前，已有报价按陈旧数据展示"}
        </span>
      </div>
      <div className="app-content">{children}</div>
    </div>
  );
}

function PanelView({
  panel,
  snapshot,
  connectionState,
  nowMs,
  onChanged,
}: {
  panel: Snapshot["view"]["panels"][number];
  snapshot: Snapshot;
  connectionState: ConnectionState;
  nowMs: number;
  onChanged: () => Promise<void>;
}): React.ReactNode {
  const [deactivating, setDeactivating] = useState(false);
  const instrument = snapshot.instruments[panel.instrumentId];
  const quotes = snapshot.quotes.filter((quote) => quote.instrumentId === panel.instrumentId);
  const sourceIds = new Set(quotes.map((quote) => quote.sourceId));
  const health = instrument ? snapshot.health.filter(entry => sourceIds.has(entry.sourceId)) : snapshot.health;
  const news = instrument ? snapshot.news.filter(item => item.instrumentIds.includes(panel.instrumentId)) : snapshot.news;
  const [actionError, setActionError] = useState<string | null>(null);
  const chartWidgets = panel.widgets.filter(widget => widget.kind === "sparkline" || widget.kind === "candlestick");
  const [chartId, setChartId] = useState("");
  const activeChart = chartWidgets.find(widget => widget.id === chartId) ?? chartWidgets.find(widget => widget.kind === "candlestick" && widget.options.timeframe === "1d") ?? chartWidgets.find(widget => widget.kind === "candlestick") ?? chartWidgets[0];
  const scope = { panel, instrument, quotes, health, egress: instrument ? snapshot.egress.filter(row => sourceIds.has(row.sourceId)) : snapshot.egress, news, positions: snapshot.positions, transactions: snapshot.transactions, pnlSummary: snapshot.pnlSummary, instruments: snapshot.instruments, sections: snapshot.view.sections, onChanged };
  const status = panelStatus(panel, snapshot, connectionState, nowMs);
  const contentWidgets = panel.widgets.filter(widget => widget.kind !== "sparkline" && widget.kind !== "candlestick").map(widget => (
    <div className="widget-slot" key={widget.id} data-widget-kind={widget.kind}><WidgetRenderer widget={widget} connectionState={connectionState} nowMs={nowMs} scope={scope} /></div>
  ));
  return (
    <article className={`panel ${chartWidgets.length ? "panel--market" : ""}`} data-asset-class={panel.assetClass}>
      <header className="panel-header">
        <div>
          {instrument ? <p className="eyebrow">INSTRUMENT DETAIL</p> : null}
          <h2>{panel.title}</h2>
          {instrument ? <p className="panel-symbol">{instrument.symbol}</p> : null}
          {instrument?.origin === "user" ? (
            <button
              className="instrument-deactivate"
              type="button"
              disabled={deactivating}
              onClick={() => {
                setDeactivating(true);
                void deleteInstrument(panel.instrumentId)
                  .then(onChanged)
                  .catch(reason => setActionError(reason instanceof Error ? reason.message : String(reason)))
                  .finally(() => setDeactivating(false));
              }}
            >
              {deactivating ? "停用中…" : "停用（保留历史）"}
            </button>
          ) : null}
        </div>
        {instrument ? <span className={`status-badge status--${status}`} title="综合本标的所需能力及各来源的状态">{statusIcon(status)} {statusLabel(status)}</span> : null}
      </header>
      {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
      <div className="panel-widgets">
        {panel.panelId === "portfolio" ? <><AllBrokerPositions /><details className="manual-ledger-fold"><summary>手工记录（备用） · 展开录入与查看手工账本</summary><p className="chart-note">用于补充未接入券商的交易，金额单独统计。请勿重复录入已同步的成交。</p><div className="panel-widgets">{contentWidgets}</div></details></> : contentWidgets}
        {activeChart ? <div className="widget-slot chart-workspace">
          <div className="chart-source-tabs" aria-label="选择图表与来源">
            {[...chartWidgets].sort((a,b) => Number(b.kind === "candlestick") - Number(a.kind === "candlestick")).map(widget => <button key={widget.id} type="button" aria-pressed={activeChart.id === widget.id} onClick={() => setChartId(widget.id)}>{widget.kind === "candlestick" ? (widget.options.timeframe === "1d" ? "日 K" : `${String(widget.options.timeframe)} K`) : "分时图"} · {String(widget.options.sourceId ?? "数据源")}</button>)}
          </div>
          <WidgetRenderer key={activeChart.id} widget={activeChart} connectionState={connectionState} nowMs={nowMs} scope={scope} />
        </div> : null}
      </div>
    </article>
  );
}

function LoadingState({ message, error = false }: { message: string; error?: boolean }): React.ReactNode {
  return <main className={`loading-state ${error ? "loading-state--error" : ""}`}><div className="loading-mark">{error ? "×" : "…"}</div><p>{message}</p></main>;
}

function connectionLabel(state: ConnectionState): string {
  return {
    connected: "实时推送已连接",
    connecting: "正在连接",
    reconnecting: "正在重新连接",
    disconnected: "实时推送中断",
  }[state];
}

function useEventStream(
  onEvent: (event: ServerEvent) => void,
  enabled: boolean,
  onUnauthorized: () => void,
  onConnected: () => void,
): ConnectionState {
  const callbackRef = useRef(onEvent);
  const lastEventId = useRef("");
  const [state, setState] = useState<ConnectionState>("connecting");
  useEffect(() => {
    callbackRef.current = onEvent;
  }, [onEvent]);
  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let retryAttempt = 0;

    if (!enabled) {
      setState("connecting");
      return () => {
        disposed = true;
      };
    }

    const connect = () => {
      if (disposed) return;
      setState(retryAttempt === 0 ? "connecting" : "reconnecting");
      const query = lastEventId.current ? `?lastEventId=${encodeURIComponent(lastEventId.current)}` : "";
      source = new EventSource(`/api/events${query}`, { withCredentials: true });
      source.onopen = () => {
        retryAttempt = 0;
        setState("connected");
        onConnected();
      };
      const handleMessage = (message: MessageEvent<string>) => {
        try {
          const parsed: unknown = JSON.parse(message.data);
          if (!isServerEvent(parsed)) return;
          lastEventId.current = parsed.id;
          callbackRef.current(parsed);
        } catch {
          setState("disconnected");
        }
      };
      for (const eventType of SSE_EVENT_TYPES) source.addEventListener(eventType, handleMessage as EventListener);
      source.onerror = () => {
        if (disposed) return;
        source?.close();
        source = null;
        setState("disconnected");
        void sessionIsValid().then((valid) => {
          if (disposed) return;
          if (!valid) {
            disposed = true;
            onUnauthorized();
            return;
          }
          const delay = Math.min(15_000, 1_000 * (2 ** Math.min(retryAttempt, 4)));
          retryAttempt += 1;
          retryTimer = window.setTimeout(connect, delay);
        }).catch(() => {
          if (disposed) return;
          const delay = Math.min(15_000, 1_000 * (2 ** Math.min(retryAttempt, 4)));
          retryAttempt += 1;
          retryTimer = window.setTimeout(connect, delay);
        });
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, onUnauthorized, onConnected]);
  return state;
}

function isUnauthorizedError(reason: unknown): boolean {
  return reason instanceof ApiError && reason.status === 401;
}

function mergeSnapshots(current: Snapshot, next: Snapshot): Snapshot {
  if (next.generation > current.generation) return next;
  if (next.generation < current.generation) return current;
  return {
    ...next,
    quotes: mergeQuotes(current.quotes, next.quotes),
    health: mergeHealth(current.health, next.health),
    news: mergeNews(current.news, next.news),
  };
}

function mergeNews(left: NewsItem[], right: NewsItem[]): NewsItem[] {
  const merged = new Map(left.map((item) => [item.id, item]));
  for (const item of right) merged.set(item.id, item);
  return [...merged.values()]
    .sort((a, b) => Date.parse(b.publishedAt ?? b.fetchedAt) - Date.parse(a.publishedAt ?? a.fetchedAt))
    .slice(0, 200);
}

function mergeQuotes(left: QuoteEnvelope[], right: QuoteEnvelope[]): QuoteEnvelope[] {
  const merged = new Map(left.map((quote) => [`${quote.instrumentId}:${quote.sourceId}`, quote]));
  for (const incoming of right) {
    const key = `${incoming.instrumentId}:${incoming.sourceId}`;
    const existing = merged.get(key);
    if (!existing || receivedAt(incoming) >= receivedAt(existing)) merged.set(key, incoming);
  }
  return [...merged.values()];
}

function mergeHealth(left: SourceHealth[], right: SourceHealth[]): SourceHealth[] {
  const merged = new Map(left.map((health) => [`${health.sourceId}:${health.capability}`, health]));
  for (const incoming of right) {
    const key = `${incoming.sourceId}:${incoming.capability}`;
    const existing = merged.get(key);
    if (!existing || incoming.observedAtMs >= existing.observedAtMs) merged.set(key, incoming);
  }
  return [...merged.values()];
}

function mergeEgress(left: SourceEgressStatus[], right: SourceEgressStatus[]): SourceEgressStatus[] {
  const merged = new Map(left.map((status) => [status.sourceId, status]));
  for (const status of right) merged.set(status.sourceId, status);
  return [...merged.values()];
}

function applyQuoteEvent(snapshot: Snapshot, payload: Record<string, unknown>): Snapshot {
  const instrumentId = typeof payload.instrumentId === "string" ? payload.instrumentId : null;
  const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : null;
  if (!instrumentId || !sourceId) return snapshot;
  const existing = snapshot.quotes.find((quote) => quote.instrumentId === instrumentId && quote.sourceId === sourceId);
  const incoming = createQuoteEnvelope(payload, existing);
  if (!incoming) return snapshot;
  if (existing && receivedAt(incoming) < receivedAt(existing)) return snapshot;
  const quotes = snapshot.quotes.filter((quote) => !(quote.instrumentId === instrumentId && quote.sourceId === sourceId));
  return { ...snapshot, quotes: [...quotes, incoming] };
}

function applyHealthEvent(snapshot: Snapshot, payload: Record<string, unknown>): Snapshot {
  const sourceHealth = asSourceHealth(payload.sourceHealth);
  const egressStatus = asSourceEgressStatus(payload.egressStatus);
  let next = sourceHealth
    ? {
        ...snapshot,
        health: mergeHealth(snapshot.health, [sourceHealth]),
        quotes: sourceHealth.capability === "quote"
          ? snapshot.quotes.map((quote) => quote.sourceId === sourceHealth.sourceId ? { ...quote, sourceHealth } : quote)
          : snapshot.quotes,
      }
    : snapshot;
  if (egressStatus) next = { ...next, egress: mergeEgress(next.egress, [egressStatus]) };
  const affected = Array.isArray(payload.affectedQuotes) ? payload.affectedQuotes : [];
  for (const item of affected) {
    if (typeof item !== "object" || item === null) continue;
    const affectedPayload = item as Record<string, unknown>;
    next = applyQuoteEvent(next, affectedPayload);
  }
  return next;
}

function applyNewsEvent(snapshot: Snapshot, payload: Record<string, unknown>): Snapshot {
  const news = asNewsItem(payload.news);
  return news ? { ...snapshot, news: mergeNews(snapshot.news, [news]) } : snapshot;
}

function asNewsItem(value: unknown): NewsItem | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<NewsItem>;
  return typeof candidate.id === "string"
    && typeof candidate.sourceId === "string"
    && typeof candidate.title === "string"
    && typeof candidate.url === "string"
    && Array.isArray(candidate.instrumentIds)
    ? candidate as NewsItem
    : null;
}

function createQuoteEnvelope(payload: Record<string, unknown>, existing?: QuoteEnvelope): QuoteEnvelope | null {
  const instrumentId = typeof payload.instrumentId === "string" ? payload.instrumentId : existing?.instrumentId;
  const sourceId = typeof payload.sourceId === "string" ? payload.sourceId : existing?.sourceId;
  const freshness = asFreshness(payload.freshness) ?? existing?.freshness;
  if (!instrumentId || !sourceId || !freshness) return null;
  return {
    instrumentId,
    sourceId,
    providerSymbol: typeof payload.providerSymbol === "string" ? payload.providerSymbol : existing?.providerSymbol ?? "—",
    quoteAsset: typeof payload.quoteAsset === "string" ? payload.quoteAsset : existing?.quoteAsset ?? "—",
    priority: typeof payload.priority === "number" ? payload.priority : existing?.priority ?? 0,
    egressProfile: typeof payload.egressProfile === "string" ? payload.egressProfile : existing?.egressProfile ?? "—",
    quote: "quote" in payload ? payload.quote as QuoteEnvelope["quote"] : existing?.quote ?? null,
    freshness,
    sourceHealth: asSourceHealth(payload.sourceHealth) ?? existing?.sourceHealth ?? null,
  };
}

function asFreshness(value: unknown): Freshness | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Freshness>;
  return typeof candidate.capturedAt === "string"
    && typeof candidate.receivedAt === "string"
    && typeof candidate.status === "string"
    && typeof candidate.staleAfterSeconds === "number"
    && typeof candidate.isStale === "boolean"
    && typeof candidate.freshnessBasis === "string"
    ? candidate as Freshness
    : null;
}

function asSourceHealth(value: unknown): SourceHealth | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<SourceHealth>;
  return typeof candidate.sourceId === "string"
    && typeof candidate.capability === "string"
    && typeof candidate.observedAtMs === "number"
    && typeof candidate.status === "string"
    && typeof candidate.successRate === "string"
    ? candidate as SourceHealth
    : null;
}

function asSourceEgressStatus(value: unknown): SourceEgressStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<SourceEgressStatus>;
  return typeof candidate.sourceId === "string"
    && (candidate.configuredPrimaryEgress === "direct" || candidate.configuredPrimaryEgress === "corp" || candidate.configuredPrimaryEgress === "vpn")
    && (candidate.latestActualEgress === null || candidate.latestActualEgress === "direct" || candidate.latestActualEgress === "corp" || candidate.latestActualEgress === "vpn")
    && typeof candidate.fallbackCount1h === "number"
    ? candidate as SourceEgressStatus
    : null;
}

function receivedAt(quote: QuoteEnvelope): number {
  return Date.parse(quote.freshness.receivedAt);
}

