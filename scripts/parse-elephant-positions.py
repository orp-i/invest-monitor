#!/usr/bin/env python3
"""Parse the newest supplied Elephant closing-position statement. No DB writes."""
import calendar
import hashlib
import json
import re
import fitz
import sys
from datetime import datetime, timezone
from decimal import Decimal as D
from pathlib import Path

def parse(path):
    with fitz.open(path) as document:
        text = '\f'.join(page.get_text(sort=True) for page in document)
    stamp = re.search(r'(日|月)結單\s+(\d{4})/(\d{2})(?:/(\d{2}))?', text)
    if not stamp: raise ValueError('Missing statement date')
    year, month = int(stamp[2]), int(stamp[3])
    day = int(stamp[4]) if stamp[4] else calendar.monthrange(year, month)[1]
    date = f'{year:04d}-{month:02d}-{day:02d}'
    start = text.index('期末概覽-股票和股票期權')
    block = text[start:].split('已交收資金摘要')[0]
    number = r'-?[\d,]+(?:\.\d+)?'
    pattern = re.compile(r'^([A-Z][A-Z0-9.]*)\(.*?\s+US\s+USD\s+('+number+r')\s+('+number+r')\s+(-|'+number+r')\s+('+number+r')', re.M)
    decimal = lambda x: D(x.replace(',', ''))
    positions=[]
    for m in pattern.finditer(block):
        symbol=m[1]; occ=re.fullmatch(r'([A-Z]+)(\d{6})([CP])(\d+)',symbol)
        if occ: symbol=occ[1]+occ[2]+occ[3]+occ[4].zfill(8)
        quantity, price, value = decimal(m[2]),decimal(m[3]),decimal(m[5])
        multiplier = decimal(m[4]) if m[4]!='-' else D(1)
        if occ and m[4]=='-': raise ValueError('Option multiplier missing')
        if abs(quantity*price*multiplier-value)>D('.011'): raise ValueError('Position value does not reconcile: '+symbol)
        positions.append(dict(id='elephant-'+symbol,symbol=symbol,quantity=str(quantity),currency='USD',costBasis=None,averageCost=None,marketValue=str(value),unrealizedPnl=None,markPrice=str(price),assetType='OPT' if occ else 'STK',multiplier=str(multiplier)))
    if not positions or len({p['symbol'] for p in positions})!=len(positions): raise ValueError('Missing/duplicate positions')
    summary=text[text.index('期末資產淨值總覽'):start]
    amounts = lambda label: re.search(label+r'\s+('+number+r')\s+('+number+r')\s+('+number+r')',summary)
    stock, nav, unsettled=amounts('股票和股票期權'),amounts('資產淨值'),amounts('待交收資金')
    if not stock or not nav or not unsettled: raise ValueError('Incomplete ending USD summary')
    if any(decimal(m[2])!=0 for m in [stock,nav,unsettled]): raise ValueError('Non-USD assets require explicit FX handling')
    if sum(D(p['marketValue']) for p in positions)!=decimal(stock[3]): raise ValueError('Closing holdings do not sum to USD statement total')
    if decimal(stock[3])+decimal(unsettled[3])!=decimal(nav[3]): raise ValueError('USD NAV does not reconcile')
    settled_block = text[start:].split('已交收資金摘要',1)[1].split('期末資產淨值總覽',1)[1]
    settled = re.search('資產淨值'+r'\s+('+number+r')\s+('+number+r')\s+('+number+r')',settled_block)
    if not settled or decimal(settled[2])!=0: raise ValueError('Settled USD balance is missing or mixed with HKD')
    cash = decimal(settled[3])
    tail = re.search(r'投資賬號[：:]?\s*(\d{10,})',text)
    if not tail: raise ValueError('Account identity missing')
    sha=hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(broker='elephant',accountId='结单账户 · '+tail[1][-4:],environment='statement',syncedAt=datetime.now(timezone.utc).isoformat(),asOf=date,currency='USD',equity=str(decimal(nav[3])+cash),cash=str(cash),unrealizedPnl=None,sessionRealizedPnl=None,
        allocation=[dict(assetType='未交收资金',value=str(decimal(unsettled[3])))],positions=positions,trades=[],
        sourceStatement=dict(fileName=path.name,sha256=sha,page=text[:start].count('\f')+1,reportDate=date),
        notes=['大象期末持仓来自最新提供结单，尚未取得结单日之后的持仓变动。',f'美元总资金 = 投资资产净值 {decimal(nav[3])} + 独立列示的已交收资金 {cash}；未交收资金已包含于投资资产净值，不重复相加。','持仓成本通过已导入开仓成交核对，无法核实的字段保留为空。','已到期但结单仍列示的期权保留原持仓，等待到期/行权确认，不推定清零。'])

if __name__=='__main__':
    files=list(Path(sys.argv[1]).glob('大象*.pdf'))
    snapshots=[parse(p) for p in files]
    latest=max(snapshots,key=lambda s:s['asOf'])
    output=Path(sys.argv[2]);output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(latest,ensure_ascii=False,indent=2));output.chmod(0o600)
    print(json.dumps(dict(file=latest['sourceStatement']['fileName'],asOf=latest['asOf'],positions=len(latest['positions']),symbols=[p['symbol'] for p in latest['positions']],reconciled=True),ensure_ascii=False))
