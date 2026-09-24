import { XMLParser } from "fast-xml-parser";

export interface FeedEntry {
  readonly url: string;
  readonly title: string;
  readonly contentText: string | null;
  readonly publishedAt: string | null;
  readonly publisher: string | null;
}

export interface ParsedFeed {
  readonly title: string | null;
  readonly entries: readonly FeedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  trimValues: true,
  parseTagValue: false,
  processEntities: true,
});

export function parseSyndicationFeed(xml: string, feedUrl: string): ParsedFeed {
  const document = parser.parse(xml) as unknown;
  const root = record(document);
  const rssChannel = record(record(root.rss).channel);
  if (Object.keys(rssChannel).length > 0) return parseRssChannel(rssChannel, feedUrl);

  const rdf = record(root["rdf:RDF"]);
  if (Object.keys(rdf).length > 0) {
    return {
      title: text(rdf.title),
      entries: array(rdf.item).map((item) => rssEntry(record(item), feedUrl)).filter(isFeedEntry),
    };
  }

  const atom = record(root.feed);
  if (Object.keys(atom).length > 0) return parseAtomFeed(atom, feedUrl);
  throw new Error("document is not an RSS, RDF, or Atom feed");
}

function parseRssChannel(channel: Record<string, unknown>, feedUrl: string): ParsedFeed {
  return {
    title: text(channel.title),
    entries: array(channel.item).map((item) => rssEntry(record(item), feedUrl)).filter(isFeedEntry),
  };
}

function rssEntry(item: Record<string, unknown>, feedUrl: string): FeedEntry | null {
  const rawUrl = text(item.link) ?? text(item.guid);
  const title = cleanText(text(item.title) ?? "");
  const url = absoluteHttpUrl(rawUrl, feedUrl);
  if (!url || !title) return null;
  const rawContent = text(item["content:encoded"]) ?? text(item.description) ?? text(item.summary);
  return {
    url,
    title,
    contentText: nullableCleanText(rawContent),
    publishedAt: timestamp(text(item.pubDate) ?? text(item["dc:date"]) ?? text(item.date)),
    publisher: nullableCleanText(text(item.source) ?? text(item.author) ?? text(item["dc:creator"])),
  };
}

function parseAtomFeed(feed: Record<string, unknown>, feedUrl: string): ParsedFeed {
  return {
    title: cleanText(text(feed.title) ?? "") || null,
    entries: array(feed.entry).map((entry) => atomEntry(record(entry), feedUrl)).filter(isFeedEntry),
  };
}

function atomEntry(entry: Record<string, unknown>, feedUrl: string): FeedEntry | null {
  const title = cleanText(text(entry.title) ?? "");
  const link = atomLink(entry.link);
  const url = absoluteHttpUrl(link ?? text(entry.id), feedUrl);
  if (!url || !title) return null;
  const rawContent = text(entry.content) ?? text(entry.summary);
  return {
    url,
    title,
    contentText: nullableCleanText(rawContent),
    publishedAt: timestamp(text(entry.published) ?? text(entry.updated)),
    publisher: nullableCleanText(text(record(entry.author).name) ?? text(entry.source)),
  };
}

function atomLink(value: unknown): string | null {
  const links = array(value).map(record);
  const selected = links.find((link) => !link["@rel"] || link["@rel"] === "alternate") ?? links[0];
  return selected ? text(selected["@href"]) ?? text(selected) : text(value);
}

function text(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  return text(object["#text"]) ?? text(object["#cdata"]);
}

function cleanText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<(?:br|\/p|\/div|\/li)\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nullableCleanText(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = cleanText(value);
  return cleaned || null;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

function timestamp(value: string | null): string | null {
  if (!value) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function absoluteHttpUrl(value: string | null, feedUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, feedUrl);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function array(value: unknown): unknown[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

function isFeedEntry(value: FeedEntry | null): value is FeedEntry {
  return value !== null;
}
