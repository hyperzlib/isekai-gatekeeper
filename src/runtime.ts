import type { AppConfig } from "./types/config.ts";
import type { ServiceContainer } from "./types/service.ts";
import { CacheService } from "./services/cacheService.ts";
import { CleanupService } from "./services/cleanupService.ts";
import { ProxyService } from "./services/proxyService.ts";
import { TemplateService } from "./services/templateService.ts";
import { GeoIPService } from "./services/geoipService.ts";
import { CaptchaService } from "./services/captchaService.ts";
import { RateLimitService } from "./services/rateLimitService.ts";
import { SiteResolver } from "./services/siteResolver.ts";

export type Runtime = {
  services: ServiceContainer;
  close(): Promise<void>;
};

export async function createRuntime(cfg: AppConfig, startCleanup: boolean): Promise<Runtime> {
  const cacheService = new CacheService(cfg);
  const cleanupService = new CleanupService();
  let proxyService: ProxyService | undefined;
  let templateService: TemplateService | undefined;
  let geoipService: GeoIPService | undefined;
  let closing: Promise<void> | undefined;

  const close = (): Promise<void> => {
    if (!closing) {
      closing = (async () => {
        cleanupService.stop();
        const errors: unknown[] = [];
        for (const dispose of [
          () => proxyService?.close(),
          () => templateService?.close(),
          () => geoipService?.close(),
          () => cacheService.close(),
        ]) {
          try {
            await dispose();
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Failed to close runtime services");
      })();
    }
    return closing;
  };

  try {
    await cacheService.init();
    const siteResolver = new SiteResolver(cfg);
    proxyService = new ProxyService(cfg, cacheService, siteResolver);
    const captchaService = new CaptchaService(cfg);
    const rateLimitService = new RateLimitService(cacheService);
    templateService = new TemplateService(cfg);
    await templateService.init();
    geoipService = new GeoIPService(cfg);
    await geoipService.init();

    if (startCleanup) {
      cleanupService.register("cache-tag-expiry", 5 * 60 * 1000, () => cacheService.cleanExpiredTagIndices());
      cleanupService.start();
    }

    return {
      services: {
        cacheService,
        captchaService,
        cleanupService,
        rateLimitService,
        proxyService,
        siteResolver,
        tpl: templateService,
        geoipService,
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      console.error("[boot] Failed to release services after startup error:", closeError);
    }
    throw error;
  }
}
