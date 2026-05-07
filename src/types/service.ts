import { CacheService } from "../services/cacheService";
import { CaptchaService } from "../services/captchaService";
import { GeoIPService } from "../services/geoipService";
import { ProxyService } from "../services/proxyService";
import { RateLimitService } from "../services/rateLimitService";
import { TemplateService } from "../services/templateService";

export type ServiceContainer = {
  cacheService: CacheService;
  captchaService: CaptchaService;
  rateLimitService: RateLimitService;
  proxyService: ProxyService;
  tpl: TemplateService;
  geoipService: GeoIPService;
}