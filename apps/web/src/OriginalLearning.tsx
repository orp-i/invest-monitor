import { useEffect, useState, type ReactNode } from "react";
import { reviewContent } from "@invest/domain";
type Intent = { kind: "curve" | "psychology"; id: string };
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    return link ? <a key={i} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a> : part;
  });
}
function OriginalMarkdown({ text, onUse }: { text: string; onUse: (intent: Intent) => void }) {
  const lines = text.split('\n'), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!; if (!line.trim()) continue;
    const heading = /^(#{1,4}) (.+)$/.exec(line);
    if (heading) { const title = heading[2]!, curve = reviewContent.curves.find(c => title.endsWith(c.title)), psychology = reviewContent.psychology.find(c => title === c.title); blocks.push(<header className={`original-heading original-heading-${heading[1]!.length}`} key={i}>{heading[1]!.length <= 2 ? <h3>{title}</h3> : <h4>{title}</h4>}{(curve || psychology) && <button className="text-button" onClick={() => onUse(curve ? { kind: 'curve', id: curve.id } : { kind: 'psychology', id: psychology!.id })}>用于逐笔复盘 →</button>}</header>); continue; }
    const image = /^!\[([^\]]*)\]\(assets\/curves\/([a-z0-9_-]+\.png)\)$/.exec(line);
    if (image) { const source = `/trading-review/curves/${image[2]}`; blocks.push(<a key={i} className="original-image" href={source} target="_blank" rel="noreferrer" aria-label={`打开原图：${image[1]}`}><img src={source} alt={image[1]} loading="lazy" /></a>); continue; }
    if (line.startsWith('|')) { const rows: string[][] = []; while (i < lines.length && lines[i]!.startsWith('|')) { const cells = lines[i]!.split('|').slice(1, -1).map(v => v.trim()); if (!cells.every(v => /^:?-+:?$/.test(v))) rows.push(cells); i++; } i--; blocks.push(<div className="position-table-wrap" key={i}><table className="position-table"><thead><tr>{rows[0]?.map((c, n) => <th key={n}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((row, n) => <tr key={n}>{row.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody></table></div>); continue; }
    if (/^- /.test(line)) { const items: string[] = []; while (i < lines.length && /^- /.test(lines[i]!)) { items.push(lines[i]!.slice(2)); i++; } i--; blocks.push(<ul key={i}>{items.map((item, n) => <li key={n}>{inline(item)}</li>)}</ul>); continue; }
    if (/^---+$/.test(line)) { blocks.push(<hr key={i} />); continue; }
    const paragraph = [line]; while (i + 1 < lines.length && lines[i + 1]!.trim() && !/^(#{1,4} |!\[|\||- |---)/.test(lines[i + 1]!)) paragraph.push(lines[++i]!);
    blocks.push(<p key={i}>{inline(paragraph.join('\n'))}</p>);
  }
  return <article className="original-prose">{blocks}</article>;
}
export function OriginalLearning({ onUse }: { onUse: (intent: Intent) => void }) {
  const [text, setText] = useState(''), [error, setError] = useState(''), [chapter, setChapter] = useState('四、十种持仓盈亏路径'), [query, setQuery] = useState('');
  useEffect(() => { const controller = new AbortController(); void fetch('/trading-review/content-manual.md', { signal: controller.signal }).then(async response => { if (!response.ok) throw Error(response.status === 404 ? '当前部署未包含资料包：把 Markdown 正文放到 apps/web/public/trading-review/content-manual.md、图片放到 curves/ 后重新构建即可。' : '资料正文读取失败'); setText(await response.text()); }).catch(e => { if (e.name !== 'AbortError') setError(e.message); }); return () => controller.abort(); }, []);
  const chapters = text.split(/(?=^## )/m).map((body, i) => ({ title: /^## (.+)$/m.exec(body)?.[1] ?? '资料说明', body, id: String(i) }));
  const selected = query ? chapters.filter(c => c.body.toLowerCase().includes(query.toLowerCase())) : chapters.filter(c => chapter === 'all' || c.title === chapter);
  return <div className="original-learning"><div className="content-heading"><div><p className="eyebrow">SOURCE READER · V1.0.0</p><h3>资料包全文阅读</h3><p className="muted">按资料包正文逐段展示，保留原图、原文标注及编辑说明。</p></div><a className="secondary-button" href="/trading-review/content-manual.md" download>下载完整正文</a></div><div className="filter-toolbar"><label>章节<select aria-label="阅读章节" value={chapter} onChange={e => { setChapter(e.target.value); setQuery(''); }}><option value="all">全部正文</option>{chapters.map(c => <option key={c.id}>{c.title}</option>)}</select></label><input aria-label="搜索资料原文" placeholder="搜索正文，显示完整匹配章节" value={query} onChange={e => setQuery(e.target.value)} /></div>{error && <p className="inline-error">{error}</p>}{!text && !error && <p>正在读取资料全文…</p>}{selected.map(c => <OriginalMarkdown key={c.id} text={c.body} onUse={onUse} />)}{text && !selected.length && <p className="empty-state">未找到匹配内容。</p>}</div>;
}
