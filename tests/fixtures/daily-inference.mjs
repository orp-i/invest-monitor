// Deterministic isolated test output; never used as production research.
export function inferenceFixture(input) {
  const anchor = input.anchorCitation, historical = input.reports.find(r => r.citation !== anchor)?.citation;
  const refs = [anchor, ...(historical ? [historical] : [])];
  const market = input.markets.find(m => m.bars.length)?.citation;
  return {
    macro: { stance: 'risk-off', summary: '隔离测试：宏观压力持续，等待趋势确认。', evolution: 'unchanged', historicalComparison: '隔离测试：当前观点延续历史日报中的风险观察。',
      supporting: [{ text: '隔离测试：对照当前与历史日报。', citations: refs }], opposing: [{ text: '隔离测试：反弹是需要跟踪的分歧。', citations: [anchor] }] },
    decision: 'observe', rationale: '隔离测试：已有空头时先核对方向，尚不增加仓位。',
    actions: ['short', 'medium', 'long'].map((horizon, i) => ({ horizon, assetId: 'portfolio', instrument: ['option', 'put-spread', 'stock'][i], action: 'watch', direction: 'bearish',
      expectedHoldingSessions: [10, 30, 120][i], holdingPeriod: '隔离测试：周期依催化和趋势调整，第5/10日复核，风险失效可提前退出。',
      thesis: '隔离测试：观察风险压力的延续。', trigger: '隔离测试：关联市场同向支持。', invalidation: '隔离测试：趋势反转或风险预算不足。', risk: '隔离测试：缺少期权链与实际权利金。', positionImpact: '隔离测试：增加Put会增加已有看空方向。', citations: [anchor] })),
    reviewPlan: { firstReview: '隔离测试：检查方向。', secondReview: '隔离测试：复核延续性，不强制平仓。', mediumTerm: '隔离测试：按催化复核价差与股票。', longTerm: '隔离测试：持续检查股票长期趋势。' },
    newObservations: [{ text: '隔离测试：未来是否有更多市场支持当前趋势？', horizon: 'short', status: 'pending', evidence: '隔离测试：等待新的日K。', citations: [anchor] }],
    observationUpdates: input.observations.filter(o => market).slice(0, 1).map(o => ({ id: o.id, status: 'supported', evidence: '隔离测试：已有日K提供方向支持。', citations: [anchor, market] })),
    limitations: ['隔离测试数据，不是投资建议或真实市场结论。'],
  };
}
