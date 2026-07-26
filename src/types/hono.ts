import type { Context } from "hono";
import type { CacheService } from "../services/cacheService";
import type { CaptchaService } from "../services/captchaService";
import type { CleanupService } from "../services/cleanupService";
import type { GeoIPInfo, GeoIPService } from "../services/geoipService";
import type { ProxyService } from "../services/proxyService";
import type { RateLimitService } from "../services/rateLimitService";
import type { RuleEngineService } from "../services/ruleEngineService";
import type { SiteResolver } from "../services/siteResolver";
import type { TemplateService } from "../services/templateService";
import type { AppConfig, SiteConfig } from "./config";
import type { Decision } from "./decision";

export type AppVariables = {
  appConfig: AppConfig;
  cacheService: CacheService;
  captchaService: CaptchaService;
  cleanupService: CleanupService;
  geoipService: GeoIPService;
  proxyService: ProxyService;
  rateLimitService: RateLimitService;
  ruleEngine?: RuleEngineService;
  siteResolver: SiteResolver;
  tpl: TemplateService;
  geoip?: GeoIPInfo;
  decision?: Decision;
  currentSiteId?: string;
  currentSite?: SiteConfig;
  currentSiteMatchedHost?: string;
  validatedClientId?: string | null;
  requestIp?: string;
  ruleEngineState?: Record<string, any>;
};

export type AppEnv = {
  Variables: AppVariables;
};

export type AppContext = Context<AppEnv>;

export type RuleContext = Omit<
  Context<AppEnv>,
  "body" | "html" | "json" | "notFound" | "redirect" | "render" | "text"
>;
