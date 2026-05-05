import path from "path";
import fs from "fs/promises";
import Handlebars, { HelperDelegate, TemplateDelegate } from "handlebars";
import type { FSWatcher } from "chokidar";
import { env } from "../config/env";
import { Context } from "koa";
import { Dirent } from "fs";
import { AppConfig } from "../types/config";

const TEMPLATE_EXT = ".hbs";
const PARTIALS_SUBDIR = "partials";

export class TemplateBuilder {
  constructor(
    private tplService: TemplateService,
    private tplName: string,
    private data: Record<string, any> = {},
  ) { }

  assign(key: string, value: any): this {
    this.data[key] = value;
    return this;
  }

  assignAll(data: Record<string, any>): this {
    Object.assign(this.data, data);
    return this;
  }

  delete(key: string): this {
    delete this.data[key];
    return this;
  }

  reset(): this {
    this.data = {};
    return this;
  }

  render(): string {
    return this.tplService.render(this.tplName, this.data);
  }

  flush(ctx: Context): void {
    const content = this.render();
    ctx.type = "text/html; charset=utf-8";
    ctx.body = content;
  }
}

export class TemplateService {
  private readonly hbs: typeof Handlebars;
  private readonly cache = new Map<string, TemplateDelegate>();
  private templatesDir: string;
  private isDev: boolean;
  private watcher: FSWatcher | null = null;

  constructor(appConfig: AppConfig) {
    this.templatesDir = path.resolve(appConfig.templates_dir);
    this.isDev = appConfig.debug ?? false;

    this.hbs = Handlebars.create();
    this.registerBuiltinHelpers();
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------

  /** 预加载所有模板和 partials，dev 模式下启动文件监听 */
  public async init(): Promise<void> {
    await this.loadAll();
    if (this.isDev) {
      await this.startWatcher();
    }
  }

  /** 关闭文件监听器（服务关闭时调用） */
  public async close(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：扫描 & 加载
  // ---------------------------------------------------------------------------

  private async loadAll(): Promise<void> {
    try {
      await fs.access(this.templatesDir);
    } catch {
      console.warn(`[TemplateService] Templates directory not found, skipping preload: ${this.templatesDir}`);
      return;
    }

    const files = await this.scanDir(this.templatesDir);
    const results = await Promise.allSettled(files.map((f) => this.loadFile(f)));

    let loaded = 0;
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("[TemplateService] Failed to load template file:", result.reason);
      } else {
        loaded++;
      }
    }
    console.info(`[TemplateService] Preloaded ${loaded}/${files.length} template files from ${this.templatesDir}`);
  }

  private async scanDir(dir: string): Promise<string[]> {
    const files: string[] = [];
    const walk = async (current: string) => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (err) {
        console.warn(`[TemplateService] Cannot read directory: ${current}`);

        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(TEMPLATE_EXT)) {
          files.push(fullPath);
        }
      }
    };
    await walk(dir);
    return files;
  }

  /** 加载单个文件：partials/ 子目录下视为 partial，其余视为模板 */
  private async loadFile(filePath: string): Promise<void> {
    const rel = path.relative(this.templatesDir, filePath);
    const parts = rel.split(path.sep);

    let source: string;
    try {
      source = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      throw new Error(`[TemplateService] Cannot read file "${filePath}": ${(err as Error).message}`);
    }

    if (parts[0] === PARTIALS_SUBDIR) {
      const partialName = parts.slice(1).join("/").replace(/\.hbs$/, "");
      this.hbs.registerPartial(partialName, source);
      console.debug(`[TemplateService] Registered partial: ${partialName}`);
    } else {
      const tplName = parts.join("/").replace(/\.hbs$/, "");
      try {
        const compiled = this.hbs.compile(source);
        this.cache.set(tplName, compiled);
        console.debug(`[TemplateService] Compiled template: ${tplName}`);
      } catch (err) {
        throw new Error(`[TemplateService] Compile error in "${tplName}": ${(err as Error).message}`);
      }
    }
  }

  private unloadFile(filePath: string): void {
    const rel = path.relative(this.templatesDir, filePath);
    const parts = rel.split(path.sep);

    if (parts[0] === PARTIALS_SUBDIR) {
      const partialName = parts.slice(1).join("/").replace(/\.hbs$/, "");
      this.hbs.unregisterPartial(partialName);
      console.debug(`[TemplateService] Unregistered partial: ${partialName}`);
    } else {
      const tplName = parts.join("/").replace(/\.hbs$/, "");
      this.cache.delete(tplName);
      console.debug(`[TemplateService] Removed template: ${tplName}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 内部：chokidar 热重载（仅 dev）
  // ---------------------------------------------------------------------------

  private async startWatcher(): Promise<void> {
    const { watch } = await import("chokidar");

    this.watcher = watch(this.templatesDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });

    const onAddOrChange = (filePath: string) => {
      if (!filePath.endsWith(TEMPLATE_EXT)) return;
      this.loadFile(filePath).catch((err) => {
        console.error("[TemplateService] Hot-reload failed:", filePath, err);
      });
    };

    this.watcher
      .on("add", onAddOrChange)
      .on("change", onAddOrChange)
      .on("unlink", (filePath: string) => {
        if (!filePath.endsWith(TEMPLATE_EXT)) return;
        this.unloadFile(filePath);
      })
      .on("error", (err: unknown) => {
        console.error("[TemplateService] Watcher error:", err);
      });

    console.info(`[TemplateService] Watching for template changes: ${this.templatesDir}`);
  }

  private registerBuiltinHelpers(): void {
    // {{eq a b}} — 相等比较
    this.hbs.registerHelper("eq", (a, b) => a === b);
    // {{ne a b}} — 不等比较
    this.hbs.registerHelper("ne", (a, b) => a !== b);
    // {{and a b}} — 逻辑与
    this.hbs.registerHelper("and", (a, b) => Boolean(a && b));
    // {{or a b}} — 逻辑或
    this.hbs.registerHelper("or", (a, b) => Boolean(a || b));
    // {{not a}} — 逻辑非
    this.hbs.registerHelper("not", (a) => !a);
    // {{json value}} — 将值序列化为 JSON 字符串
    this.hbs.registerHelper("json", (value) => JSON.stringify(value));
    // {{default value fallback}} — 若 value 为 falsy 则使用 fallback
    this.hbs.registerHelper("default", (value, fallback) => value ?? fallback);
    // {{concat a b c}} — 连接字符串
    this.hbs.registerHelper("concat", (...args) => {
      const options = args.pop();
      return args.join("");
    });
  }

  /** 注册自定义 helper */
  public registerHelper(name: string, fn: HelperDelegate): this {
    this.hbs.registerHelper(name, fn);
    return this;
  }

  /** 注册 partial */
  public registerPartial(name: string, partial: string): this {
    this.hbs.registerPartial(name, partial);
    return this;
  }

  /** 清除已编译的模板缓存 */
  public clearCache(tplName?: string): void {
    if (tplName) {
      this.cache.delete(tplName);
    } else {
      this.cache.clear();
    }
  }

  /** 创建 TemplateBuilder */
  public create(tplName: string): TemplateBuilder {
    return new TemplateBuilder(this, tplName);
  }

  /** 从模板名渲染 */
  public render(tplName: string, data: Record<string, any>): string {
    const template = this.cache.get(tplName);
    if (!template) {
      throw new Error(`Template not found: "${tplName}". Make sure init() was called and the template file exists.`);
    }
    return template(data);
  }

  /** 直接从字符串编译并渲染，不读取文件 */
  public renderString(source: string, data: Record<string, any>): string {
    const template = this.hbs.compile(source);
    return template(data);
  }
}