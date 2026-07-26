import type { AppContext } from "../types/hono.ts";
import type { AppConfig, SiteConfig } from "../types/config.ts";
import { getRequestHostCandidates, normalizeConfiguredHostname } from "../utils/host.ts";
import { getRequestHost, getRequestProtocol } from "../utils/request.ts";

export interface ResolvedSite {
  id: string;
  config: SiteConfig;
  matchedHost: string;
}

export class SiteResolver {
  private readonly sites: ResolvedSite[] = [];

  constructor(appConfig: AppConfig) {
    for (const [id, config] of Object.entries(appConfig.sites)) {
      const hostnames = Array.isArray(config.hostname) ? config.hostname : [config.hostname];
      for (const hostname of hostnames) {
        this.sites.push({
          id,
          config,
          matchedHost: normalizeConfiguredHostname(hostname),
        });
      }
    }
  }

  public resolve(ctx: AppContext): ResolvedSite | null {
    return this.resolveHost(getRequestHost(ctx), getRequestProtocol(ctx));
  }

  public resolveHost(hostHeader: string | string[] | undefined, protocol?: string): ResolvedSite | null {
    const candidates = getRequestHostCandidates(hostHeader, protocol);
    for (const candidate of candidates) {
      const site = this.sites.find((entry) => entry.matchedHost === candidate);
      if (site) return site;
    }
    return null;
  }
}
