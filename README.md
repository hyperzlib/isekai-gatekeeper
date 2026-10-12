# Isekai Gatekeeper

另一个基于 PoE 的反向代理，用于防护猖獗的 AI 爬虫

为 WordPress 和 MediaWiki 优化

## 特性

- 使用 JS 表达式进行规则配置，灵活强大
- 内置多种验证码支持（Google reCAPTCHA、hCaptcha、GeeTest）
- 可选的 GeoIP 信息
- 页面缓存功能，支持通过API管理缓存

## ProxyApp 多 worker

在 `config.ts` 的 `proxy` 中设置 `workers`，默认是 `1`。单 worker 沿用原来的双端口单进程启动方式。设置为大于 `1` 时，主进程运行 ApiApp 和缓存索引清理任务，每个子进程仅运行 ProxyApp。此时必须把 `cache.provider` 设为 `"bun+redis"` 或 `"redis"`，并配置对应的 Redis URL，使页面缓存、限流和管理 API 共用状态。

`workers` 也支持 `"auto"`：Linux 使用 `node:os.cpus().length` 返回的逻辑 CPU 数量，Windows/macOS 始终使用 `1`。Linux 自动解析出多个 worker 时同样需要 Redis。Windows/macOS 启动时会提示：需要多 worker 时手动设置数量，并使用 nginx 反向代理分流到各 worker 的连续端口。

Linux 上所有 ProxyApp worker 共用 `proxy.server_port`。Windows/macOS 上 worker 从 `proxy.server_port` 开始逐个占用连续端口；例如 `server_port: 8080, workers: 3` 会监听 8080、8081、8082，`api.server_port` 必须在这个范围之外。Windows/macOS 部署时须让 nginx 将流量分配到全部 ProxyApp 端口。启动日志会列出 worker 编号、端口和进程号；意外退出的 worker 会在延迟后由主进程重启。

## 对比

| 功能/项目          | Isekai Gatekeeper                      | [Cloudflare](https://www.cloudflare.com/) | [Anubis](https://anubis.io/) |
| ------------------ | -------------------------------------- | ----------------------------------------- | ---------------------------- |
| 反向代理           | ✅                                      | ✅                                         | ✅                            |
| 页面缓存           | ✅                                      | ✅                                         | ❌                            |
| 基于规则的访问控制 | ✅                                      | ✅                                         | ✅                            |
| PoE验证模式        | GPU hashcash                           | 未知                                      | ❌                            |
| 验证码支持         | Google reCAPTCHA、hCaptcha、GeeTest 等 | Cloudflare CAPTCHA                        | ❌                            |
| 规则表达式         | JS 表达式                              | Cloudflare 规则语言                       | Anubis 规则配置              |
| GeoIP 信息         | 可选                                   | ✅                                         | ❌                            |
| 性能               | 中等性能                               | 高性能                                    | 高性能                       |
| 开源               | ✅                                      | ❌                                         | ✅                            |
| 开发语言           | TypeScript + Bun.js                    | 未知                                      | Go                           |
| 其他问题           |                                        | 中国大陆访问 Cloudflare 可能不稳定        |                              |

如果仅需拦截 AI 爬虫，Isekai Gatekeeper 可能并非最佳选择，推荐使用 [Anubis](https://anubis.io/) 这类专注于 AI 爬虫防护的解决方案。但如果你想允许部分页面被爬虫抓取，且保证正常用户访问体验，Isekai Gatekeeper 的基于规则的访问控制和缓存功能可能更适合你的需求。

## Roadmap
- [x] 基础功能
  - [x] 反向代理
  - [x] 基于规则的访问控制
  - [x] 日志记录
- [x] 缓存功能
  - [x] 页面缓存功能
  - [x] Redis 缓存
  - [x] 缓存管理API
- [x] 验证码功能
  - [x] Google reCAPTCHA
  - [x] GeeTest
  - [ ] hCaptcha (需要测试)
  - [ ] Fun Captcha (需要测试)
  - [ ] Aliyun CAPTCHA (需要测试)
  - [ ] Tencent Cloud CAPTCHA (需要测试)
  - [ ] Cloudflare Turnstile (需要测试)
- [x] GeoIP功能
  - [x] 基于 GeoIP 的访问控制
- [x] 限流功能
  - [x] 限流基础功能
  - [x] 针对已通过验证码的用户的限流（再次验证）
  - [ ] 针对服务器负载的动态限流
- [ ] 多语言支持
  - [ ] 前端界面国际化支持
  - [ ] 文档翻译
