import type { ResearchSource } from "@invest/domain";

export function ResearchSources({ sources = [], sourceUrl = "" }: { sources?: ResearchSource[]; sourceUrl?: string }) {
  if (!sources.length) return sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">原始资料 ↗</a> : <span className="muted">待补充原始来源</span>;
  return <div className="study-sources">{sources.map((s, i) => <div key={`${s.url}-${i}`}>
    <a href={s.url} target="_blank" rel="noreferrer">{i + 1}. {s.title} ↗</a>
    <small>{s.publisher} · 发布 {s.publishedAt || "日期未注明"} · 查阅 {s.accessedAt}</small>
    {s.evidence && <details><summary>来源支持的事实</summary><p>{s.evidence}</p></details>}
  </div>)}{sourceUrl && !sources.some(s => s.url === sourceUrl) && <a href={sourceUrl} target="_blank" rel="noreferrer">补充资料 ↗</a>}</div>;
}
