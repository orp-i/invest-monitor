"""Targeted parser checks; run with python3 -m unittest discover -s tests -p 'test_statement_parser.py'."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('statement_parser', Path(__file__).parents[1] / 'scripts/parse-trade-statements.py')
parser = importlib.util.module_from_spec(spec)
spec.loader.exec_module(parser)


class EmptyStatementTests(unittest.TestCase):
    complete = '日結單 2026/09/07\n期初資產淨值總覽\n期末資產淨值總覽\n已交收資金摘要'

    def test_complete_account_only_statement(self):
        parser.no_trade_statement(self.complete + '\n資金進出\n融券總覽')

    def test_unrecognized_execution_table_is_not_empty(self):
        for marker in ['買賣方向', '成交金額合計', '賣出平倉', '變動金額']:
            with self.assertRaises(ValueError):
                parser.no_trade_statement(self.complete + '\n' + marker)

    def test_truncated_statement_is_rejected(self):
        for marker in ['日結單 2026/09/07', '期初資產淨值總覽', '期末資產淨值總覽', '已交收資金摘要']:
            with self.assertRaises(ValueError):
                parser.no_trade_statement(self.complete.replace(marker, ''))
