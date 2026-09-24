import type { EgressName, EgressProfile } from "@invest/config";
import type { DailyLlmConnection, DailyLlmRouteProbe } from "@invest/domain";
import type { EgressHttpClient } from "@invest/egress";

// Market/news routing may map every profile to one proxy. LLM direct must bypass it.
export function dailyLlmEgressProfiles(profiles: Record<EgressName, EgressProfile>): Record<EgressName, EgressProfile> {
  return { ...profiles, direct: { ...profiles.direct, proxyUrl: null } };
}
const CACHE_MS = 15 * 60_000, FAILURE_CACHE_MS = 30_000;
const empty = (mode: DailyLlmConnection["mode"]): DailyLlmConnection => ({ mode, selected: mode === "auto" ? null : mode,
  recommended: null, checkedAt: null, expiresAt: null, probes: [], note: mode === "auto" ? "首次分析前检测直连与VPN；也可手动检测。" : "按指定出口连接，可检测两条线路作对照。" });

export class DailyLlmEgress {
  private state: DailyLlmConnection;
  private checkedFingerprint = "";
  private pending: Promise<DailyLlmConnection> | null = null;
  private controller = new AbortController();
  constructor(private readonly http: EgressHttpClient, private readonly modelsUrl: string, private readonly key: string,
    private readonly model: string, private readonly mode: DailyLlmConnection["mode"]) { this.state = empty(mode); }

  private fingerprint() { return JSON.stringify(["direct", "vpn", "corp"].map(p => this.http.profile(p as EgressName)?.proxyUrl)); }
  status(): DailyLlmConnection { return structuredClone(this.checkedFingerprint && this.checkedFingerprint !== this.fingerprint() ? empty(this.mode) : this.state); }
  invalidate() { this.state.expiresAt = new Date(0).toISOString(); this.state.note = "上次推理连接异常，可重新检测；自动模式下次会重新选择。"; }
  async close() { this.controller.abort(); await this.pending?.catch(() => undefined); }

  async route(signal: AbortSignal): Promise<EgressName | null> {
    if (signal.aborted || this.controller.signal.aborted) return null;
    if (this.mode !== "auto") return this.mode === "vpn" && !this.http.profile("vpn").proxyUrl ? null : this.mode;
    const state = this.status();
    const checked = state.expiresAt && Date.parse(state.expiresAt) > Date.now() ? state : await this.check(signal);
    return signal.aborted ? null : checked.selected;
  }

  async check(signal?: AbortSignal): Promise<DailyLlmConnection> {
    if (this.controller.signal.aborted || signal?.aborted) return this.status();
    if (this.pending) return structuredClone(await this.pending);
    const fingerprint = this.fingerprint(), previous = this.status();
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
    this.pending = (async () => {
      const profiles: EgressName[] = this.mode === "corp" ? ["direct", "vpn", "corp"] : ["direct", "vpn"];
      const probes = await Promise.all(profiles.map(p => this.probe(p, combined)));
      if (combined.aborted || fingerprint !== this.fingerprint()) return this.status();
      const recommended = selectDailyLlmRoute(probes, previous.recommended);
      const selected = this.mode === "auto" ? recommended : this.mode, checkedAt = new Date().toISOString();
      const best = probes.find(p => p.profile === recommended);
      const stable = best?.modelAvailable === true && best.successes === best.attempts;
      this.checkedFingerprint = fingerprint;
      this.state = { mode: this.mode, selected, recommended, checkedAt,
        expiresAt: new Date(Date.now() + (recommended ? stable ? CACHE_MS : 60_000 : FAILURE_CACHE_MS)).toISOString(), probes,
        note: recommended ? best?.modelAvailable === null ? "模型列表接口不受支持，仅确认网络可达；实际推理仍需验证，检测结果复用1分钟。" : stable ? "按模型可用性、成功率与延迟选择；检测结果复用15分钟。" : "检测出现短暂失败，当前选择成功过的较优线路；仅复用1分钟，之后重新检测。"
          : "未找到可用线路，请检查下方的网络、鉴权或模型提示。" };
      return this.status();
    })();
    try { return structuredClone(await this.pending); } finally { this.pending = null; }
  }

  private async probe(name: EgressName, signal: AbortSignal): Promise<DailyLlmRouteProbe> {
    const result: DailyLlmRouteProbe = { profile: name, attempts: 0, successes: 0, medianMs: null, modelAvailable: null, httpStatus: null, issue: null };
    const profile = this.http.profile(name);
    if (name === "vpn" && !profile.proxyUrl) return { ...result, issue: "未配置VPN代理地址。" };
    if (name === "direct" && profile.proxyUrl) return { ...result, issue: "直连出口仍带代理，请检查独立LLM出口配置。" };
    const elapsed: number[] = [];
    for (let i = 0; i < 2 && !signal.aborted; i++) {
      result.attempts++;
      const started = performance.now();
      try {
        const reply = await this.http.request({ url: this.modelsUrl, method: "GET", headers: { authorization: `Bearer ${this.key}` },
          egressProfile: name, egressFallback: [], userAgent: profile.userAgent, followRedirects: false, maxRedirects: 0,
          connectTimeoutMs: profile.connectTimeoutMs, requestTimeoutMs: 8000, signal });
        if (!reply.ok) { result.issue = reply.error.kind === "timeout" ? "连接检测超时。" : "网络连接失败。"; continue; }
        const response = reply.value; result.httpStatus = response.status;
        let parsed: any = null;
        try { if (response.body.byteLength <= 2_000_000) parsed = JSON.parse(new TextDecoder().decode(response.body)); } catch { /* An HTML page is not an API success. */ }
        if (response.status >= 200 && response.status < 300 && Array.isArray(parsed?.data)) {
          result.modelAvailable = parsed.data.some((m: any) => m?.id === this.model);
          if (!result.modelAvailable) { result.issue = "模型列表不包含配置的模型。"; continue; }
        } else if ([404, 405].includes(response.status) && parsed?.error) {
          result.modelAvailable = null; result.issue = "该服务未提供模型列表，只确认网络可达。";
        } else {
          result.issue = response.status === 401 || response.status === 403 ? "API鉴权或访问权限失败。"
            : response.status === 429 ? "API速率或配额受限。" : response.status >= 500 ? "上游服务暂不可用。" : "未取得有效的模型列表API响应。";
          continue;
        }
        result.successes++; elapsed.push(Math.round(performance.now() - started));
      } catch { result.issue = "连接检测失败。"; }
    }
    if (elapsed.length) result.medianMs = elapsed.reduce((sum, n) => sum + n, 0) / elapsed.length; // two samples: median == mean
    if (result.successes === result.attempts && result.modelAvailable) result.issue = null;
    return result;
  }
}

export function selectDailyLlmRoute(probes: DailyLlmRouteProbe[], previous: EgressName | null = null): EgressName | null {
  const candidates = probes.filter(p => p.successes > 0 && p.modelAvailable !== false && p.medianMs !== null);
  const score = (p: DailyLlmRouteProbe) => (p.modelAvailable ? 10 : 0) + p.successes / Math.max(1, p.attempts);
  candidates.sort((a, b) => score(b) - score(a) || a.medianMs! - b.medianMs!);
  const best = candidates[0]; if (!best) return null;
  // Small timing differences are noise: keep the previous healthy route, otherwise prefer direct.
  const preferred = candidates.find(p => p.profile === previous) ?? candidates.find(p => p.profile === "direct");
  if (preferred && score(preferred) === score(best) && preferred.medianMs! - best.medianMs! <= Math.max(100, best.medianMs! * .2)) return preferred.profile;
  return best.profile;
}
