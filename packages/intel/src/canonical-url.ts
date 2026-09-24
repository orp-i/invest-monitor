const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "referrer",
  "source",
  "campaign",
  "cmpid",
  "ocid",
  "rss",
]);

export function canonicalizeNewsUrl(value: string, stripTracking = true): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("news URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("news URL must not contain credentials");
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) {
    url.port = "";
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  if (stripTracking) {
    for (const name of [...url.searchParams.keys()]) {
      if (name.toLowerCase().startsWith("utm_") || TRACKING_PARAMETERS.has(name.toLowerCase())) {
        url.searchParams.delete(name);
      }
    }
  }
  url.searchParams.sort();
  return url.toString();
}
