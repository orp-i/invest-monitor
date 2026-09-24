import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { EgressName, EgressProfile } from "@invest/config";

export type EgressProfiles = Record<EgressName, EgressProfile>;

export interface EgressRoute {
  readonly name: EgressName;
  readonly profile: EgressProfile;
  readonly dispatcher: Dispatcher;
}

export class EgressDispatcherPool {
  private readonly dispatchers: Record<EgressName, Dispatcher>;

  public constructor(private readonly profiles: EgressProfiles) {
    this.dispatchers = {
      direct: createDispatcher(profiles.direct),
      corp: createDispatcher(profiles.corp),
      vpn: createDispatcher(profiles.vpn),
    };
  }

  public get(name: EgressName): Dispatcher {
    return this.dispatchers[name];
  }

  public profile(name: EgressName): EgressProfile {
    return this.profiles[name];
  }

  public route(primary: EgressName, fallback: readonly EgressName[]): readonly EgressRoute[] {
    const seen = new Set<EgressName>();
    return [primary, ...fallback]
      .filter((name) => {
        if (seen.has(name)) return false;
        seen.add(name);
        return true;
      })
      .map((name) => ({
        name,
        profile: this.profiles[name],
        dispatcher: this.dispatchers[name],
      }));
  }

  public async close(): Promise<void> {
    await Promise.all(Object.values(this.dispatchers).map((dispatcher) => dispatcher.close()));
  }
}

function createDispatcher(profile: EgressProfile): Dispatcher {
  if (profile.proxyUrl) {
    return new ProxyAgent({ uri: profile.proxyUrl, connectTimeout: profile.connectTimeoutMs });
  }
  return new Agent({ connections: 16, pipelining: 1, connectTimeout: profile.connectTimeoutMs });
}
