import { CacheService } from "../services/cacheService";
import { CaptchaService } from "../services/captchaService";
import { GeoIPService } from "../services/geoipService";
import { ProxyService } from "../services/proxyService";
import { TemplateService } from "../services/templateService";

export type ServiceContainer = {
  cacheService: CacheService;
  captchaService: CaptchaService;
  proxyService: ProxyService;
  tpl: TemplateService;
  geoipService: GeoIPService;
}