import { z } from "zod";
import { STUDY_INSTRUMENTS } from "./research-market.js";

export const MarketReportDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, "日期无效");
export const MARKET_STANCES = { unset: "未判断", "risk-on": "风险偏好上升", "risk-off": "风险偏好下降", neutral: "中性", mixed: "分化" } as const;
export const MarketDailyWriteSchema = z.object({
  date: MarketReportDaySchema,
  title: z.string().trim().min(1, "请填写标题").max(200),
  summary: z.string().trim().max(1000).default(""),
  body: z.string().trim().max(50000),
  stance: z.enum(["unset", "risk-on", "risk-off", "neutral", "mixed"]).default("unset"),
  drivers: z.string().trim().max(3000).default(""),
  watch: z.string().trim().max(3000).default(""),
  sourceUrl: z.string().max(2000).refine(value => { try { return !value || ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } }, "来源必须为 http/https 链接").default(""),
  assetIds: z.array(z.string().refine(id => STUDY_INSTRUMENTS.some(asset => asset.id === id), "关联资产无效")).max(STUDY_INSTRUMENTS.length).default([]),
  status: z.enum(["draft", "ready", "archived"]),
}).strict().superRefine((value, ctx) => {
  if (value.status === "ready" && !value.body) ctx.addIssue({ code: "custom", path: ["body"], message: "保存日报前请填写正文" });
});
export type MarketDailyWrite = z.infer<typeof MarketDailyWriteSchema>;
export type MarketDailyReport = MarketDailyWrite & { id: string; revision: number; createdAt: string; updatedAt: string };
export type MarketDailySummary = Omit<MarketDailyReport, "body"> & { excerpt?: string };
/** Display-only lead of the user's own body text for lists that omit the full body; never a generated summary. */
export function marketDailyExcerpt(body: string, max = 200): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max), stop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("！"), cut.lastIndexOf("."));
  return `${stop >= max * 0.6 ? cut.slice(0, stop + 1) : cut}…`;
}
export type MarketDailyRevision = Pick<MarketDailyReport, "revision" | "updatedAt" | "status" | "title" | "summary" | "stance">;
export interface MarketDailyQuery { from: string; to: string; status?: MarketDailyWrite["status"] | "all"; limit: number }
export interface MarketDailyContextQuery { from: string; to: string; asOf: string; limit: number }
export type MarketDailySaveResult = { status: "saved"; report: MarketDailyReport } | { status: "missing" | "revision-conflict" | "date-conflict" | "date-immutable" };
export interface MarketDailyContext {
  schemaVersion: 1;
  generatedAt: string;
  asOf: string;
  from: string;
  to: string;
  dateTimezone: "Asia/Shanghai";
  hasMore: boolean;
  guidance: string;
  reports: (MarketDailyReport & { citation: string })[];
}
export function marketReportToday(now = new Date()): string { return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10); }
