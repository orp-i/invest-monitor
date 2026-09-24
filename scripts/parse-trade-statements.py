#!/usr/bin/env python3
"""Read the supplied Elephant / Tradier PDFs, reconcile amounts, emit private JSON.

No database writes. Each fill retains file hash, page and original time. This parser
fails closed if the statement layout or totals change; it is not a general OCR tool.
Requires PyMuPDF. Usage: python3 scripts/parse-trade-statements.py trade_file output.json
"""
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from decimal import Decimal as D, ROUND_HALF_UP
from pathlib import Path

import fitz

def digest(*values):
    return hashlib.sha256(json.dumps(values, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()

def dec(value):
    return D(value.replace(',', ''))

def plain(value):
    return format(value, 'f')

def expect(condition, message):
    if not condition:
        raise ValueError(message)

def no_trade_statement(text):
    # A missing/changed execution table must not silently become an empty import.
    execution_markers = ['買賣方向', '成交金額', '變動金額', '買入開倉', '買入平倉', '賣出開倉', '賣出平倉']
    expect(not any(marker in text for marker in execution_markers), '存在成交表但未识别成交，须核对结单布局')
    expect(re.search(r'(?:日|月)結單\s+\d{4}/\d{2}', text) is not None
           and all(marker in text for marker in ['期初資產淨值總覽', '期末資產淨值總覽', '已交收資金摘要']),
           '无成交结单缺少日期或完整资产摘要')

def build_fill(broker, account_key, symbol, side, action, qty, price, gross, fees, net, when, precision, settlement, file, sha, page, row, fee_parts, original_time, zone, identity_extra=''):
    qty, price, gross, fees, net = map(dec, [qty, price, gross, fees, net])
    expect(qty > 0 and price > 0 and gross > 0 and fees >= 0, '成交数量、价格或费用无效')
    multiplier = D(100) if re.fullmatch(r'[A-Z]+\d{6}[CP]\d{8}', symbol) else D(1)
    expect((qty * price * multiplier).quantize(D('.01'), rounding=ROUND_HALF_UP) == gross.quantize(D('.01')), '成交金额必须与数量、价格及合约规模核对（美元分舍入）')
    expect((gross if side == 'sell' else -gross) - fees == net, '逐笔净现金与费用不平')
    expect(sum(map(dec, fee_parts.values())) == fees, '逐项费用与小计不平')
    identity = digest(broker, account_key, symbol, side, when, plain(qty), plain(price), identity_extra)
    return dict(id=identity, transactionId='statement:' + identity, source='statement', sourceLabel=broker + ' · 结单',
        instrumentKey=digest(broker, account_key, symbol), symbol=symbol, side=side, quantity=plain(qty), price=plain(price),
        feeCost=plain(fees), multiplier=plain(multiplier), currency='USD', occurredAt=when, timePrecision=precision,
        provenance=dict(fileName=file, fileSha256=sha, page=page, row=row, broker=broker, action=action,
            settlementDate=settlement, grossAmount=plain(gross), netCash=plain(net), feeBreakdown=fee_parts,
            originalTime=original_time, originalTimezone=zone))

def elephant(path):
    doc = fitz.open(path)
    raw = '\n'.join(page.get_text() for page in doc)
    expect('按照香港時間顯示' in raw, '结单未说明香港时区')
    account = re.search(r'投資賬號[：:]\s*(\d+)', raw)
    expect(account is not None, '缺少账户归属字段')
    account_key = digest('elephant', account[1])
    lines = []
    for page_no, page in enumerate(doc, 1):
        for line in page.get_text(sort=True).splitlines():
            # Do not retain customer identity or address text in the import bundle.
            if any(s in line for s in ['客戶姓名', '投資賬號', '投資賬戶', '製備日期']):
                continue
            lines.append((page_no, line))
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    starts = [i for i, (_, line) in enumerate(lines) if re.match(r'^(買入|賣出)(開倉|平倉)\s+USD\s+', line)]
    fills = []
    for ordinal, start in enumerate(starts):
        block = lines[start:starts[ordinal+1] if ordinal+1 < len(starts) else len(lines)]
        direction = block[0][1][:4]
        row_match = None
        pattern = r'^\s*(.+?)\s+([A-Z0-9]+)\s+USD\s+(\d{4}/\d{2}/\d{2})\s+(\d{4}/\d{2}/\d{2})\s+([\d,.]+)\s+([\d,.]+)\s+([\d,.]+)\s+(-?[\d,.]+)\s*$'
        for j, (page_no, line) in enumerate(block):
            found = re.match(pattern, line)
            if found:
                row_match = (j, page_no, found); break
        expect(row_match is not None, f'{path.name} 第 {ordinal+1} 笔成交无法识别')
        j, page_no, found = row_match
        prefix, exchange, date, settle, qty, price, gross, net = found.groups()
        tail = '\n'.join(line for _, line in block[j+1:])
        fee_line = next((line for _, line in block[j+1:] if '小計:' in line and ':' in line), None)
        expect(fee_line is not None, '缺少费用小计')
        fees = re.search(r'小計:\s*([\d,.]+)', fee_line)[1]
        fee_parts = {name: amount for name, amount in re.findall(r'([^\s:]+):\s*([\d,.]+)', fee_line) if name != '小計'}
        symbol_prefix = re.sub(r'\s', '', prefix)
        if '(' in symbol_prefix:
            symbol = symbol_prefix.split('(')[0]
        else:
            continuation = next((line.strip().split('(')[0].strip() for _, line in block[j+1:] if '(' in line), '')
            symbol = symbol_prefix + continuation
        option = re.fullmatch(r'([A-Z]+)(\d{6})([CP])(\d+)', symbol)
        if option:
            symbol = option[1] + option[2] + option[3] + option[4].zfill(8)
        else:
            expect(re.fullmatch(r'[A-Z.]+', symbol) is not None, '无法识别证券代码')
        time = re.search(r'\b(\d{2}:\d{2}:\d{2})\b', tail)
        expect(time is not None, '成交时间缺失')
        original = date.replace('/', '-') + 'T' + time[1] + '+08:00'
        when = datetime.fromisoformat(original).astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        fills.append(build_fill('大象', account_key, symbol, 'buy' if direction.startswith('買') else 'sell', 'open' if direction.endswith('開倉') else 'close',
            qty, price, gross, fees, net, when, 'instant', settle.replace('/', '-'), path.name, sha, page_no, ordinal+1, fee_parts, original, 'Asia/Hong_Kong'))
    expect(len(fills) == len(starts), '成交行数不一致')
    text = '\n'.join(line for _, line in lines)
    if not fills:
        no_trade_statement('\n'.join(page.get_text(sort=True) for page in doc))
        return statement(path, sha, '大象', [], ['本结单无证券成交，保留文件来源供账户快照核对。', '成交总额、成交净现金及成交费用为零；资金划拨、融券费用及资产估值不作为成交。'])
    gross_total = dec(re.search(r'成交金額合計[：:]\s+HKD:\s*[\d,.]+\s+USD:\s*([\d,.]+)', text)[1])
    cash_total = dec(re.search(r'變動金額合計[：:]\s+HKD:\s*[\d,.]+\s+USD:\s*(-?[\d,.]+)', text)[1])
    expect(sum(dec(f['provenance']['grossAmount']) for f in fills) == gross_total, '文件成交金额总计不平')
    expect(sum(dec(f['provenance']['netCash']) for f in fills) == cash_total, '文件净现金总计不平')
    return statement(path, sha, '大象', fills, ['原结单明确采用香港时间；成交时间已转换为 UTC。', '只导入成交明细；期初期末持仓、银行划拨与汇总行不作为成交。'])

def tradier(path):
    doc = fitz.open(path)
    sha = hashlib.sha256(path.read_bytes()).hexdigest()
    raw = '\n'.join(page.get_text() for page in doc)
    # The confirmation has rotated pages; native text order preserves its columns.
    account = re.search(r'Account(?:\s+Number)?\s*[:#]?\s*([A-Z0-9-]{5,})', raw, re.I)
    expect(account is not None, 'Tradier 结单缺少账户字段')
    account_key = digest('tradier', re.sub(r'[^A-Z0-9]', '', account[1].upper()))
    pattern = re.compile(r'(?m)^2\n([BS])\n(\d{2}/\d{2}/\d{2})\n(\d{2}/\d{2}/\d{2})\n([\d,.]+)\n([\d,.]+)\n([\d,.]+)\n([\d,.]+)\n([\d,.]+)\n([\d,.]+)\n([A-Z0-9]+)\n([\d,.]+)\n([^\n]+)\n.*?Desc:\n(PUT|CALL)\s+([A-Z]+)\s+(\d{2}/\d{2}/\d{2})\s+([\d.]+)\s+[^\n]*? (OPEN|CLOSING) CONTRACT', re.S)
    fills = []
    for page_no, page in enumerate(doc, 1):
        text = page.get_text()
        for found in pattern.finditer(text):
            side, trade_date, settle, qty, price, gross, comm, tran_fee, additional, tag, net, trade_num, cp, underlying, expiry, strike, action = found.groups()
            date = datetime.strptime(trade_date, '%m/%d/%y').date().isoformat()
            settle = datetime.strptime(settle, '%m/%d/%y').date().isoformat()
            expiry = datetime.strptime(expiry, '%m/%d/%y').strftime('%y%m%d')
            symbol = underlying + expiry + ('P' if cp == 'PUT' else 'C') + str(int(dec(strike)*1000)).zfill(8)
            fee_parts = {'commission': comm, 'transactionFee': tran_fee, 'additionalFees': additional}
            fees = sum(map(dec, fee_parts.values()))
            signed_net = dec(net) if side == 'S' else -dec(net)
            fills.append(build_fill('Tradier', account_key, symbol, 'buy' if side == 'B' else 'sell', 'open' if action == 'OPEN' else 'close',
                qty, price, gross, plain(fees), plain(signed_net), date, 'day', settle, path.name, sha, page_no, len(fills)+1, fee_parts, date, None, tag))
    expect(len(fills) == raw.count('Desc:'), 'Tradier 成交行数与证券描述数不符')
    summary = re.search(r'TOTAL DOLLARS BOUGHT:\s*(-?[\d,.]+)\s+TOTAL SHARES SOLD:\s*-?[\d,.]+\s+TOTAL DOLLARS SOLD:\s*([\d,.]+)', raw)
    expect(summary is not None, 'Tradier 汇总缺失')
    for side, target in [('buy', summary[1]), ('sell', summary[2])]:
        expect(sum(dec(f['provenance']['netCash']) for f in fills if f['side'] == side) == dec(target), 'Tradier 买卖现金汇总不平')
    return statement(path, sha, 'Tradier', fills, ['确认书仅提供交易日，不推定盘中成交时间。', '佣金、交易费及附加费均计入净盈亏；以 Tag Number 区分同日成交。'])

def statement(path, sha, broker, fills, notes):
    return dict(id=sha, fileName=path.name, sha256=sha, broker=broker, fills=fills,
        grossTotal=plain(sum(dec(f['provenance']['grossAmount']) for f in fills)),
        netCash=plain(sum(dec(f['provenance']['netCash']) for f in fills)), feesTotal=plain(sum(dec(f['feeCost']) for f in fills)), notes=notes)

def main():
    source, target = Path(sys.argv[1]), Path(sys.argv[2])
    statements = []
    for path in sorted(source.glob('*.pdf')):
        statements.append(tradier(path) if path.name.startswith('tradier') else elephant(path))
    seen = {}
    for statement_data in statements:
        for fill in statement_data['fills']:
            previous = seen.get(fill['id'])
            if previous:
                expect(all(previous[k] == fill[k] for k in ['quantity', 'price', 'feeCost', 'multiplier', 'side', 'occurredAt']), '重复成交字段不一致')
            seen[fill['id']] = fill
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(dict(version=1, statements=statements), ensure_ascii=False, indent=2))
    target.chmod(0o600)
    print(json.dumps(dict(files=len(statements), rows=sum(len(s['fills']) for s in statements), uniqueFills=len(seen), reconciled=True), ensure_ascii=False))

if __name__ == '__main__':
    main()
