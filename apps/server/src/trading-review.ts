import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { Decimal } from "decimal.js";
import {
  TradingCaseInputSchema, TradingCaseProfileSchema, TradingCaseMergeSchema, TradingPlanInputSchema, TradingEvidenceInputSchema,
  TradingEventInputSchema, TradingAssessmentInputSchema, WeeklyReviewInputSchema,
  tradingCaseMetrics, weeklyReviewMetrics, reviewContent, reviewCoachPrompt, brokerReportDay,
  expirationReviewFill, withBrokerExecutionDetails, tradierSymbol, brokerPositionEffect, mergeSuggestions,
  type BrokerApiId, type ReviewFill, type TradingCase, type TradingPlan,
} from "@invest/domain";
import { pairedReviewFills } from "./auto-trading-review.js";
import type { StorageDriver } from "@invest/storage";

const key = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export async function availableReviewFills(storage: StorageDriver): Promise<ReviewFill[]> {
  const [manual, rawBrokers, statements, instruments] = await Promise.all([storage.getTransactions(), storage.getBrokerSnapshots(), storage.getStatementImports(), storage.getReviewInstrumentMetadata()]);
  const brokers = withBrokerExecutionDetails(rawBrokers, statements);
  const fills: ReviewFill[] = manual.filter(t => t.type === "buy" || t.type === "sell").map(t => ({
    id: key("manual", t.id), transactionId: t.id, source: "manual", instrumentKey: key("manual", t.accountId, t.instrumentId), accountKey: key("manual", t.accountId),
    symbol: instruments.find(i => i.id === t.instrumentId)?.symbol ?? t.instrumentId, side: t.type as "buy" | "sell", quantity: t.quantity, price: t.price,
    feeCost: t.fees, multiplier: instruments.find(i => i.id === t.instrumentId)?.contractMultiplier ?? null, currency: t.currency, occurredAt: new Date(t.tradeAtMs).toISOString(), timePrecision: "instant",
  }));
  // Use explicit broker multipliers. Adjusted options must not default to 100.
  // Elephant snapshot trades refer to the same immutable statement fills below.
  for (const account of brokers.filter(a => a.broker !== "elephant")) for (const t of account.trades.filter(t => !t.statementFillId)) fills.push({
    id: key(account.broker, account.environment, account.accountId, t.id), transactionId: t.id, source: account.broker as BrokerApiId,
    instrumentKey: key(account.broker, account.environment, account.accountId, tradierSymbol(t.symbol)), accountKey: key(account.broker, account.environment, account.accountId), symbol: t.symbol,
    side: t.side, quantity: t.quantity, price: t.price,
    netCash: t.netCash, feeCost: t.statementFees ?? t.totalFees ?? (t.fees === null || (t.feeCurrency && t.feeCurrency !== t.currency) ? null : account.broker === "ibkr" ? new Decimal(t.fees).negated().toFixed() : t.fees),
    multiplier: t.multiplier ?? (/^(stock|stocks|equity|equities|etf|stk)$/i.test(t.assetType) ? "1" : null),
    sourceLabel: `${account.broker.toUpperCase()}${account.environment === "sandbox" ? " · 模拟" : ""}`, environment: account.environment, positionEffect: brokerPositionEffect(account, t), feeCurrency: t.feeCurrency, realizedPnl: t.realizedPnl,
    // An order observed in its session upgrades the nightly date to the fill instant; the report date stays on the trade.
    currency: t.currency, occurredAt: t.executedAt ?? t.tradedAt, timePrecision: t.executedAt ? "instant" : t.timePrecision,
    lotId: t.lotId ?? null, orderGroupId: t.orderGroupId ?? null,
  });
  const imports = new Map(statements.flatMap(s => s.fills.map(f => [f.id, f] as const)));
  const statementBroker = new Map(statements.flatMap(s => s.fills.map(f => [f.id, s.broker] as const)));
  fills.push(...[...imports.values()].map(f => ({ ...f, accountKey: f.accountKey ?? key("statement", statementBroker.get(f.id) ?? "unknown"), transactionAliases: brokers.flatMap(a => a.trades.filter(t => t.statementFillId === f.id).map(t => t.id)) })));

  for (const account of brokers) for (const trade of account.trades) {
    const opening = trade.expirationConfirmation && imports.get(trade.expirationConfirmation.openingFillId);
    if (opening) fills.push({ ...expirationReviewFill(trade, opening, account.broker), accountKey: key("statement", statementBroker.get(opening.id) ?? "unknown") });
  }
  return fills.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id));
}


// Read-time enrichment leaves the recorded evidence untouched while accounting
// uses newly synced settlement cash and verified contract metadata.
export async function currentTradingCases(storage: StorageDriver): Promise<TradingCase[]> {
  const [cases, fills] = await Promise.all([storage.getTradingCases(), availableReviewFills(storage)]);
  const current = new Map(fills.map(f => [f.id, f]));
  const paired = new Set(pairedReviewFills(fills).map(g => JSON.stringify(g.map(f => f.id).sort())));
  return cases.map(c => ({ ...c, ...(paired.has(JSON.stringify(c.fillIds.slice().sort())) ? { historyComplete: true, pairingBasis: "同账户、同标的成交已自动配对；仅有日期时不推断日内开平顺序。原始复盘记录保留。" } : {}), fills: c.fills.map(f => {
    const latest = current.get(f.id);
    if (!latest) return f;
    // Later broker evidence (lot pairing, session order time) refines the read view; the stored fill keeps its original values.
    const preciseTime = f.timePrecision === "day" && latest.timePrecision === "instant" && brokerReportDay(latest.occurredAt) === brokerReportDay(f.occurredAt);
    return { ...f, positionEffect: f.positionEffect ?? f.provenance?.action ?? latest.positionEffect, netCash: latest.netCash, feeCost: latest.feeCost, multiplier: f.multiplier ?? latest.multiplier,
      ...(preciseTime ? { occurredAt: latest.occurredAt, timePrecision: "instant" as const } : {}), lotId: latest.lotId ?? f.lotId ?? null, orderGroupId: latest.orderGroupId ?? f.orderGroupId ?? null };
  }) }));
}

function planTiming(entry: TradingCase, recordedAt: string): TradingPlan["recordingTiming"] {
  if (!entry.fills.length) return "before_entry";
  if (entry.fills.some(f => f.timePrecision !== "instant")) return "unknown";
  return entry.fills.every(f => Date.parse(f.occurredAt) > Date.parse(recordedAt)) ? "before_entry" : "backfilled";
}
function checkReferences(entry: TradingCase, ids: string[]) {
  if (ids.some(id => !entry.evidence.some(e => e.id === id))) throw new Error("引用的证据不存在，请刷新后重新选择");
}
function notFuture(value: string | null, now: string) {
  if (value && Date.parse(value) > Date.parse(now)) throw new Error("实际事件或信息可获得时间不能在未来；预期事件请写入计划");
}
const linkSchema = z.object({ fillIds: z.array(z.string().min(1)).min(1).max(200), historyComplete: z.boolean() }).strict();

/** Called after the host application's authentication and CSRF checks. */
export async function tradingReviewRequest(method: string, path: string, body: unknown, storage: StorageDriver): Promise<{ status: number; body: unknown }> {
  const now = new Date().toISOString();
  try {
    if (method === "GET" && path === "/api/trading-review") {
      const [cases, fills, weekly, research, statements] = await Promise.all([currentTradingCases(storage), availableReviewFills(storage), storage.getWeeklyReviews(), storage.getResearchEntries(), storage.getStatementImports()]);
      const owners = new Map(cases.flatMap(c => c.fills.map(f => [f.id, c.id] as const)));
      const suggestions = mergeSuggestions(cases, pairedReviewFills(fills));
      return { status: 200, body: { cases, suggestions, fills: fills.map(f => ({ ...f, caseId: owners.get(f.id) ?? null })), weekly, research: research.map(r => ({ id: r.id, title: r.title, topic: r.topic })), statements: statements.map(({ fills, ...s }) => ({ ...s, fillCount: fills.length })), contentVersion: reviewContent.contentVersion } };
    }
    if (method === "POST" && path === "/api/trading-review/cases") {
      const input = TradingCaseInputSchema.parse(body);
      const available = await availableReviewFills(storage);
      const fills = input.fillIds.map(id => { const fill = available.find(f => f.id === id); if (!fill) throw new Error("成交已不可用，请刷新后重新选择"); return fill; });
      const entry: TradingCase = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, fills, plans: [], evidence: [], events: [], assessments: [], linkHistory: [{ recordedAt: now, fillIds: input.fillIds, historyComplete: input.historyComplete }] };
      await storage.createTradingCase(entry);
      return { status: 201, body: { entry } };
    }
    if (method === "POST" && path === "/api/trading-review/weekly") {
      const input = WeeklyReviewInputSchema.parse(body);
      const cases = await currentTradingCases(storage);
      if ([input.goodCaseId, input.mistakeCaseId, input.riskyWinCaseId].some(id => id && !cases.some(c => c.id === id))) throw new Error("所选案例不存在");
      const metrics = weeklyReviewMetrics(cases, input);
      // Freeze chart inputs too; later imports or edits cannot rewrite a saved week.
      const brokerFills = (await availableReviewFills(storage)).filter(f => { const day = brokerReportDay(f.occurredAt); return (f.source === "ibkr" || f.source === "tradier") && day !== null && day >= input.weekStart && day <= input.weekEnd; });
      const entry = { ...input, id: randomUUID(), recordedAt: now, metrics, caseSnapshots: cases, brokerFills };
      await storage.createWeeklyReview(entry);
      return { status: 201, body: { entry } };
    }
    const match = /^\/api\/trading-review\/cases\/([^/]+)\/(plans|evidence|events|assessments|fills|export|profile|merge)$/.exec(path);
    if (!match) return { status: 404, body: { message: "复盘接口不存在" } };
    const [, caseId, action] = match;
    if (method === "GET" && action === "export") {
      const entry = (await currentTradingCases(storage)).find(c => c.id === caseId);
      if (!entry) return { status: 404, body: { message: "复盘档案不存在" } };
      // Explicit fields only: no account numbers, broker external IDs, env or credentials.
      const data = { ...entry, fillIds: undefined, fills: entry.fills.map(({ transactionId, transactionAliases, instrumentKey, provenance, ...f }) => f), metrics: tradingCaseMetrics(entry) };
      const curveIds = entry.assessments.flatMap(a => a.curveIds), psychIds = entry.assessments.flatMap(a => a.psychologyIds);
      return { status: 200, body: { prompt: reviewCoachPrompt, data, knowledge: { curves: reviewContent.curves.filter(c => curveIds.includes(c.id)), psychology: reviewContent.psychology.filter(c => psychIds.includes(c.id)), riskMethods: reviewContent.riskMethods.filter(c => entry.plans.some(p => p.riskMethodIds.includes(c.id))) } } };
    }
    if (method !== "POST" || action === "export") return { status: 405, body: { message: "历史记录仅支持追加" } };
    if (action === "profile") {
      const profile = TradingCaseProfileSchema.parse(body);
      const entry = await storage.updateTradingCase(caseId!, current => {
        const previous = { title: current.title, strategy: current.strategy, horizon: current.horizon, instrumentType: current.instrumentType };
        if (JSON.stringify(previous) === JSON.stringify(profile)) return current;
        // Descriptive fields are editable so auto-paired cases can record the real intent; old values stay in history.
        current.profileHistory = [...(current.profileHistory ?? []), { ...previous, recordedAt: now }];
        Object.assign(current, profile); current.updatedAt = now;
        return current;
      });
      return { status: entry ? 200 : 404, body: entry ? { entry } : { message: "复盘档案不存在" } };
    }
    if (action === "merge") {
      const { sourceCaseIds } = TradingCaseMergeSchema.parse(body);
      if (sourceCaseIds.includes(caseId!)) throw new Error("不能合并档案自身");
      const entry = await storage.mergeTradingCases(caseId!, sourceCaseIds, (target, sources) => {
        // Only cases without review records can be absorbed, so no assessment, evidence, event or plan is ever lost.
        for (const source of sources) if (source.plans.length || source.evidence.length || source.events.length || source.assessments.length) throw new Error(`待合并档案“${source.title}”已有复盘记录；请改为把本档案合并到它，或分别记录`);
        const moved: string[] = [];
        for (const source of sources) for (const fill of source.fills) if (!target.fills.some(f => f.id === fill.id)) { target.fills.push(fill); moved.push(fill.id); }
        target.fillIds = target.fills.map(f => f.id);
        target.historyComplete = target.historyComplete && sources.every(s => s.historyComplete);
        target.linkHistory.push({ recordedAt: now, fillIds: moved, historyComplete: target.historyComplete, mergedFrom: sources.map(s => ({ id: s.id, title: s.title, fillIds: s.fillIds })) });
        target.updatedAt = now;
        return target;
      });
      return { status: entry ? 200 : 404, body: entry ? { entry } : { message: "复盘档案不存在" } };
    }
    const input = action === "plans" ? TradingPlanInputSchema.parse(body)
      : action === "evidence" ? TradingEvidenceInputSchema.parse(body)
      : action === "events" ? TradingEventInputSchema.parse(body)
      : action === "assessments" ? TradingAssessmentInputSchema.parse(body) : linkSchema.parse(body);
    const linkedFills = action === "fills" ? await availableReviewFills(storage) : [];
    const news = action === "evidence" ? await storage.getNews(undefined, 1000) : [];
    const research = action === "evidence" ? await storage.getResearchEntries() : [];
    const accountingView = action === "assessments" ? (await currentTradingCases(storage)).find(c => c.id === caseId) : undefined;
    const entry = await storage.updateTradingCase(caseId!, current => {
      if (action === "plans") {
        const plan = TradingPlanInputSchema.parse(input);
        if (plan.previousPlanId !== (current.plans.at(-1)?.id ?? null)) throw new Error("计划已有新记录，请刷新后基于最新计划追加");
        checkReferences(current, plan.evidenceIds);
        current.plans.push({ ...plan, id: randomUUID(), recordedAt: now, recordingTiming: planTiming(current, now) });
      } else if (action === "evidence") {
        const evidence = TradingEvidenceInputSchema.parse(input); notFuture(evidence.availableAt, now);
        const sourceSnapshot: { title: string; url: string; text: string }[] = [];
        if (evidence.newsId) {
          const source = news.find(n => n.id === evidence.newsId); if (!source) throw new Error("新闻已不可用，请使用来源链接记录");
          sourceSnapshot.push({ title: source.title, url: source.url, text: source.summary ?? "" });
        }
        if (evidence.researchId) {
          const source = research.find(r => r.id === evidence.researchId); if (!source) throw new Error("宏观判断不存在");
          sourceSnapshot.push({ title: source.title, url: source.sourceUrl, text: `事实：${source.facts}\n判断：${source.thesis}\n证伪：${source.invalidation}` });
        }
        current.evidence.push({ ...evidence, id: randomUUID(), recordedAt: now, sourceSnapshot });
      } else if (action === "events") {
        const event = TradingEventInputSchema.parse(input); notFuture(event.occurredAt, now); checkReferences(current, event.evidenceIds);
        current.events.push({ ...event, id: randomUUID(), recordedAt: now });
      } else if (action === "assessments") {
        const assessment = TradingAssessmentInputSchema.parse(input); checkReferences(current, assessment.evidenceIds);
        current.assessments.push({ ...assessment, id: randomUUID(), recordedAt: now, stage: tradingCaseMetrics(accountingView ?? current).state === "closed" ? "retrospective" : "provisional", basisFillIds: current.fills.map(f => f.id), basisPlanId: current.plans.at(-1)?.id ?? null });
      } else {
        const links = linkSchema.parse(input);
        for (const id of new Set(links.fillIds)) {
          if (current.fills.some(f => f.id === id)) continue;
          const fill = linkedFills.find(f => f.id === id); if (!fill) throw new Error("成交已不可用，请刷新后重新选择");
          current.fills.push(fill);
        }
        current.fillIds = current.fills.map(f => f.id); current.historyComplete = links.historyComplete;
        current.linkHistory.push({ recordedAt: now, fillIds: [...new Set(links.fillIds)], historyComplete: links.historyComplete });
        // Classification is derived against current fills; original plans stay immutable.
      }
      current.updatedAt = now;
      return current;
    });
    return { status: entry ? 200 : 404, body: entry ? { entry } : { message: "复盘档案不存在" } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { message: error.issues.map(i => i.message).join("；") } };
    // Only our domain validation messages are exposed, never driver details.
    const message = error instanceof Error ? error.message : "";
    const safe = /^(同一成交|成交已|所选案例|引用的证据|实际事件|计划已有|新闻已|宏观判断不存在|待合并档案|不能合并)/.test(message);
    return { status: safe ? 409 : 500, body: { message: safe ? message : "复盘保存失败，请重试；原记录已保留" } };
  }
}
