import koa, { DefaultContext } from "koa";
import { CacheService } from "./services/cacheService";
import { CaptchaService } from "./services/captchaService";
import { ProxyService } from "./services/proxyService";
import { RuleEngineService } from "./services/ruleEngineService";
import { AppConfig } from "./types/config";
import { TemplateService } from "./services/templateService";
import { GeoIPInfo, GeoIPService } from "./services/geoipService";

declare module "koa" {
  interface DefaultContext {
    cacheService: CacheService;
    captchaService: CaptchaService;
    proxyService: ProxyService;
    appConfig: AppConfig;
    tpl: TemplateService;
    geoipService: GeoIPService;
    ruleEngine?: RuleEngineService;

    geoip?: GeoIPInfo;
  }
}