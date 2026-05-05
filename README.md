# Isekai Gatekeeper

另一个基于 PoE 的反向代理，用于防护猖獗的 AI 爬虫

为 WordPress 和 MediaWiki 优化

## 特性

- 使用 JS 表达式进行规则配置，灵活强大
- 内置多种验证码支持（Google reCAPTCHA、hCaptcha、GeeTest）
- 可选的 GeoIP 信息
- 页面缓存功能，支持通过API管理缓存

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
  - [x] hCaptcha
  - [x] GeeTest
- [x] GeoIP功能
  - [x] 基于 GeoIP 的访问控制
- [ ] 限流功能
  - [ ] 限流基础功能
  - [ ] 针对已通过验证码的用户的限流（再次验证）
  - [ ] 针对服务器负载的动态限流