import { Decimal } from "decimal.js";
import type { TransactionType } from "./schemas.js";

const Money = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

export interface PositionLedgerTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly instrumentId: string;
  readonly type: TransactionType;
  readonly quantity: string;
  readonly price: string | null;
  readonly fees: string;
  readonly currency: string;
  readonly tradeAtMs: number;
}

export interface MovingAverageProjection {
  readonly accountId: string;
  readonly instrumentId: string;
  readonly quantity: string;
  readonly averageCost: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly quoteAsset: string;
  readonly asOfMs: number;
}

export interface PositionValuationInput extends MovingAverageProjection {
  readonly markPrice: string | null;
  readonly markQuoteAsset: string | null;
}

export interface PositionValuation {
  readonly marketValue: string | null;
  readonly unrealizedPnl: string | null;
}

export interface CostSubtotal {
  readonly currency: string;
  readonly costBasis: string;
  readonly realizedPnl: string;
  readonly grossDividend: string;
  readonly withholdingTax: string;
  readonly netIncome: string;
}

export interface ValuationSubtotal {
  readonly currency: string;
  readonly marketValue: string | null;
  readonly unrealizedPnl: string | null;
  readonly allocationPercent: string | null;
}

export interface CombinedPnlTotals {
  readonly currency: string;
  readonly costBasis: string;
  readonly marketValue: string;
  readonly realizedPnl: string;
  readonly unrealizedPnl: string;
  readonly netIncome: string;
  readonly totalPnl: string;
}

export interface PortfolioPnlSummary {
  readonly positionsCount: number;
  readonly costSubtotals: readonly CostSubtotal[];
  readonly valuationSubtotals: readonly ValuationSubtotal[];
  readonly canCombine: boolean;
  readonly combinedTotals: CombinedPnlTotals | null;
  readonly explanation: string | null;
}

interface ReplayState {
  accountId: string;
  instrumentId: string;
  quantity: InstanceType<typeof Money>;
  costBasis: InstanceType<typeof Money>;
  averageCost: InstanceType<typeof Money>;
  realizedPnl: InstanceType<typeof Money>;
  quoteAsset: string | null;
  asOfMs: number;
}

/** Replays one account/instrument ledger in caller-supplied chronological order. */
export function replayMovingAverage(
  transactions: readonly PositionLedgerTransaction[],
): MovingAverageProjection | null {
  const first = transactions[0];
  if (!first) return null;
  const state: ReplayState = {
    accountId: first.accountId,
    instrumentId: first.instrumentId,
    quantity: new Money(0),
    costBasis: new Money(0),
    averageCost: new Money(0),
    realizedPnl: new Money(0),
    quoteAsset: null,
    asOfMs: first.tradeAtMs,
  };

  for (const transaction of transactions) {
    if (transaction.accountId !== state.accountId || transaction.instrumentId !== state.instrumentId) {
      throw new Error("moving-average replay received more than one account/instrument group");
    }
    state.asOfMs = Math.max(state.asOfMs, transaction.tradeAtMs);
    if (transaction.type !== "buy" && transaction.type !== "sell") continue;
    if (state.quoteAsset !== null && state.quoteAsset !== transaction.currency) {
      throw new Error(
        `mixed transaction currencies for ${state.accountId}/${state.instrumentId}: ${state.quoteAsset} and ${transaction.currency}`,
      );
    }
    state.quoteAsset = transaction.currency;
    const quantity = new Money(transaction.quantity);
    const price = new Money(requiredPrice(transaction));
    const fees = new Money(transaction.fees);
    if (transaction.type === "buy") applyBuy(state, quantity, price, fees);
    else applySell(state, quantity, price, fees);
    forceFlatState(state);
  }

  if (state.quoteAsset === null) return null;
  return {
    accountId: state.accountId,
    instrumentId: state.instrumentId,
    quantity: plain(state.quantity),
    averageCost: plain(state.averageCost),
    costBasis: plain(state.costBasis),
    realizedPnl: plain(state.realizedPnl),
    quoteAsset: state.quoteAsset,
    asOfMs: state.asOfMs,
  };
}

export function valuePosition(position: PositionValuationInput): PositionValuation {
  if (position.markPrice === null || position.markQuoteAsset === null) {
    return { marketValue: null, unrealizedPnl: null };
  }
  const marketValue = new Money(position.quantity).mul(position.markPrice);
  return {
    marketValue: plain(marketValue),
    // The value is explicitly denominated in markQuoteAsset. If cost and mark
    // assets differ, callers must keep the two subtotals separate and explain it.
    unrealizedPnl: plain(marketValue.minus(position.costBasis)),
  };
}

export function summarizePortfolio(
  positions: readonly PositionValuationInput[],
  transactions: readonly PositionLedgerTransaction[],
  allocationUniverse?: readonly PositionValuationInput[],
): PortfolioPnlSummary {
  const positionsCount = positions.filter((position) => !new Money(position.quantity).isZero()).length;
  const costBuckets = new Map<string, MutableCostSubtotal>();
  const valuationBuckets = new Map<string, MutableValuationSubtotal>();

  for (const position of positions) {
    const cost = costBucket(costBuckets, position.quoteAsset);
    cost.costBasis = cost.costBasis.plus(position.costBasis);
    cost.realizedPnl = cost.realizedPnl.plus(position.realizedPnl);

    if (position.markQuoteAsset !== null) {
      const valuation = valuationBucket(valuationBuckets, position.markQuoteAsset);
      const marked = valuePosition(position);
      if (marked.marketValue === null || marked.unrealizedPnl === null) {
        valuation.complete = false;
      } else {
        valuation.marketValue = valuation.marketValue.plus(marked.marketValue);
        valuation.unrealizedPnl = valuation.unrealizedPnl.plus(marked.unrealizedPnl);
      }
    }
  }

  for (const transaction of transactions) {
    if (transaction.type !== "dividend" && transaction.type !== "withholding_tax") continue;
    const cost = costBucket(costBuckets, transaction.currency);
    if (transaction.type === "dividend") cost.grossDividend = cost.grossDividend.plus(transaction.quantity);
    else cost.withholdingTax = cost.withholdingTax.plus(transaction.quantity);
  }

  const universeValues = valuationUniverseTotals(allocationUniverse ?? positions);
  const costSubtotals = [...costBuckets.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((bucket) => ({
      currency: bucket.currency,
      costBasis: plain(bucket.costBasis),
      realizedPnl: plain(bucket.realizedPnl),
      grossDividend: plain(bucket.grossDividend),
      withholdingTax: plain(bucket.withholdingTax),
      netIncome: plain(bucket.grossDividend.plus(bucket.withholdingTax)),
    }));
  const valuationSubtotals = [...valuationBuckets.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((bucket) => ({
      currency: bucket.currency,
      marketValue: bucket.complete ? plain(bucket.marketValue) : null,
      unrealizedPnl: bucket.complete ? plain(bucket.unrealizedPnl) : null,
      allocationPercent: bucket.complete
        ? percentageOf(bucket.marketValue, universeValues.get(bucket.currency) ?? new Money(0))
        : null,
    }));

  const currencies = new Set([
    ...costSubtotals.map((subtotal) => subtotal.currency),
    ...valuationSubtotals.map((subtotal) => subtotal.currency),
  ]);
  const everyMarkMatchesCost = positions.every((position) =>
    position.markQuoteAsset === null || position.markQuoteAsset === position.quoteAsset);
  const canCombine = positions.length > 0
    && currencies.size === 1
    && everyMarkMatchesCost
    && valuationSubtotals.every((subtotal) => subtotal.marketValue !== null && subtotal.unrealizedPnl !== null);
  const hasUnavailableValuation = valuationSubtotals.some((subtotal) =>
    subtotal.marketValue === null || subtotal.unrealizedPnl === null);
  const hasCurrencyBoundary = currencies.size > 1 || !everyMarkMatchesCost;
  const currency = canCombine ? [...currencies][0] ?? null : null;
  const cost = currency ? costSubtotals.find((subtotal) => subtotal.currency === currency) : undefined;
  const valuation = currency ? valuationSubtotals.find((subtotal) => subtotal.currency === currency) : undefined;
  const combinedTotals = currency && cost && valuation && valuation.marketValue !== null && valuation.unrealizedPnl !== null
    ? {
        currency,
        costBasis: cost.costBasis,
        marketValue: valuation.marketValue,
        realizedPnl: cost.realizedPnl,
        unrealizedPnl: valuation.unrealizedPnl,
        netIncome: cost.netIncome,
        totalPnl: plain(new Money(cost.realizedPnl).plus(valuation.unrealizedPnl).plus(cost.netIncome)),
      }
    : null;

  return {
    positionsCount,
    costSubtotals,
    valuationSubtotals,
    canCombine,
    combinedTotals,
    explanation: canCombine
      ? null
      : hasUnavailableValuation
        ? "至少一个持仓的报价不可用；对应市值和未实现盈亏保持为空，不以 0 代替，也不生成不完整的组合总计。"
        : hasCurrencyBoundary
          ? "成本币种与报价币种不完全一致，或组合包含多个币种；未使用 FX，也未假设稳定币与 USD 为 1:1，因此只显示分币种小计。"
          : null,
  };
}

function applyBuy(
  state: ReplayState,
  quantity: InstanceType<typeof Money>,
  price: InstanceType<typeof Money>,
  fees: InstanceType<typeof Money>,
): void {
  if (state.quantity.greaterThanOrEqualTo(0)) {
    state.costBasis = state.costBasis.plus(quantity.mul(price)).plus(fees);
    state.quantity = state.quantity.plus(quantity);
    state.averageCost = state.costBasis.div(state.quantity);
    return;
  }

  const closingQuantity = Money.min(quantity, state.quantity.abs());
  const openingQuantity = quantity.minus(closingQuantity);
  const closingFee = proportionalFee(fees, closingQuantity, quantity);
  const openingFee = fees.minus(closingFee);
  state.realizedPnl = state.realizedPnl
    .plus(closingQuantity.mul(state.averageCost.minus(price)))
    .minus(closingFee);
  state.costBasis = state.costBasis.plus(closingQuantity.mul(state.averageCost));
  state.quantity = state.quantity.plus(closingQuantity);
  forceFlatState(state);
  if (openingQuantity.greaterThan(0)) {
    state.costBasis = openingQuantity.mul(price).plus(openingFee);
    state.quantity = openingQuantity;
    state.averageCost = state.costBasis.div(state.quantity);
  }
}

function applySell(
  state: ReplayState,
  quantity: InstanceType<typeof Money>,
  price: InstanceType<typeof Money>,
  fees: InstanceType<typeof Money>,
): void {
  if (state.quantity.lessThanOrEqualTo(0)) {
    state.costBasis = state.costBasis.minus(quantity.mul(price));
    state.quantity = state.quantity.minus(quantity);
    state.averageCost = state.costBasis.div(state.quantity);
    // Every sell fee reduces realized PnL and never enters average cost.
    state.realizedPnl = state.realizedPnl.minus(fees);
    return;
  }

  const closingQuantity = Money.min(quantity, state.quantity);
  const openingQuantity = quantity.minus(closingQuantity);
  const closingFee = proportionalFee(fees, closingQuantity, quantity);
  const openingFee = fees.minus(closingFee);
  state.realizedPnl = state.realizedPnl
    .plus(closingQuantity.mul(price.minus(state.averageCost)))
    .minus(closingFee);
  state.costBasis = state.costBasis.minus(closingQuantity.mul(state.averageCost));
  state.quantity = state.quantity.minus(closingQuantity);
  forceFlatState(state);
  if (openingQuantity.greaterThan(0)) {
    state.costBasis = openingQuantity.mul(price).negated();
    state.quantity = openingQuantity.negated();
    state.averageCost = state.costBasis.div(state.quantity);
    state.realizedPnl = state.realizedPnl.minus(openingFee);
  }
}

function forceFlatState(state: ReplayState): void {
  if (!state.quantity.isZero()) return;
  state.quantity = new Money(0);
  state.costBasis = new Money(0);
  state.averageCost = new Money(0);
}

function proportionalFee(
  fees: InstanceType<typeof Money>,
  part: InstanceType<typeof Money>,
  total: InstanceType<typeof Money>,
): InstanceType<typeof Money> {
  return total.isZero() ? new Money(0) : fees.mul(part).div(total);
}

function requiredPrice(transaction: PositionLedgerTransaction): string {
  if (transaction.price === null) throw new Error(`${transaction.type} transaction ${transaction.id} requires a price`);
  return transaction.price;
}

function plain(value: InstanceType<typeof Money>): string {
  return value.isZero() ? "0" : value.toFixed();
}

interface MutableCostSubtotal {
  currency: string;
  costBasis: InstanceType<typeof Money>;
  realizedPnl: InstanceType<typeof Money>;
  grossDividend: InstanceType<typeof Money>;
  withholdingTax: InstanceType<typeof Money>;
}

interface MutableValuationSubtotal {
  currency: string;
  marketValue: InstanceType<typeof Money>;
  unrealizedPnl: InstanceType<typeof Money>;
  complete: boolean;
}

function costBucket(buckets: Map<string, MutableCostSubtotal>, currency: string): MutableCostSubtotal {
  const existing = buckets.get(currency);
  if (existing) return existing;
  const created = {
    currency,
    costBasis: new Money(0),
    realizedPnl: new Money(0),
    grossDividend: new Money(0),
    withholdingTax: new Money(0),
  };
  buckets.set(currency, created);
  return created;
}

function valuationBucket(buckets: Map<string, MutableValuationSubtotal>, currency: string): MutableValuationSubtotal {
  const existing = buckets.get(currency);
  if (existing) return existing;
  const created = {
    currency,
    marketValue: new Money(0),
    unrealizedPnl: new Money(0),
    complete: true,
  };
  buckets.set(currency, created);
  return created;
}

function valuationUniverseTotals(positions: readonly PositionValuationInput[]): Map<string, InstanceType<typeof Money>> {
  const totals = new Map<string, InstanceType<typeof Money>>();
  for (const position of positions) {
    if (position.markQuoteAsset === null || position.markPrice === null) continue;
    const value = new Money(position.quantity).mul(position.markPrice);
    totals.set(position.markQuoteAsset, (totals.get(position.markQuoteAsset) ?? new Money(0)).plus(value));
  }
  return totals;
}

function percentageOf(
  value: InstanceType<typeof Money>,
  total: InstanceType<typeof Money>,
): string | null {
  if (total.isZero()) return null;
  return plain(value.div(total).mul(100));
}
