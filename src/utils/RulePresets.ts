import { Context } from "koa";
import { reverse as dnsReverse } from "dns/promises";

/**
 * 用于条件表达式中的预设判断，如判断是否是搜索引擎爬虫
 */
export class RulePresets {
  constructor(private readonly ctx: Context) { }

  public get isCommonSearchEngineBot(): boolean {
    const ua = this.ctx.request.header["user-agent"] ?? "";
    return /Googlebot|MSN|Bingbot|Slurp|DuckDuckBot|Baiduspider|Bytespider|SiteSearch360|360Spider|YisouSpider|Y!J-DLC|Yahoo! Slurp|YandexBot/i.test(ua);
  }

  public async isCommonSearchEngineBotFromIP(): Promise<boolean> {
    if (!this.isCommonSearchEngineBot) return false;
    // 使用反向 DNS 查询
    const ip = this.ctx.ip;
    try {
      const dnsNames = await dnsReverse(ip);
      return dnsNames.some(hostname => /(\.search\.msn\.com|\.googlebot\.com|\.crawl\.baidu\.com|\.yahoo\.com|\.compute-1\.amazonaws\.com|duckduckbot\.duckduckgo\.com|\.crawl\.bytedance\.com|hn\.kd\.ny\.adsl|\.crawl\.sm\.cn|\.spider\.yandex\.com)$/i.test(hostname));
    } catch {
      return false;
    }
  }

  public get isAIUserBot(): boolean {
    const ua = this.ctx.request.header["user-agent"] ?? "";
    return /ChatGPT-User|Claude-User|Bard-User|Gemini-User/i.test(ua);
  }
}
