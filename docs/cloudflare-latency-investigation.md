# Cloudflare 请求延迟排查、优化与发布验收

<!-- FINAL-SG-ROLLOUT-START -->

## 2026-07-21 最终生产结论：原域名 100% 新加坡 Worker，不再使用 Vercel

### 最终状态

- 原域名保持 `https://relay.yiheng.run`，没有迁移用户入口。
- 生产 Worker：`relay-lab`。
- 当前生产版本：`77586b5a-83ed-4752-af72-e782af89a7a0`，流量 `100%`；该版本是在已恢复原 Nuxt 登录 UI 的优化版本上更新 `REGISTRATION_INVITE_CODE` 机密。
- 性能 A/B 使用的优化候选 V34：`8e15428d-9640-4ccd-b247-384567657ee8`；当前生产版本沿用同一核心网络与数据链路优化。
- 当前 Deployment 创建时间：`2026-07-21T05:46:32.805Z`；当前 Version 创建时间：`2026-07-21T05:46:31.656Z`。
- Placement：`targeted`，目标区域 `aws:ap-southeast-1`（新加坡）。
- D1 实际 primary：`APAC / SIN`，`served_by_primary = true`。
- Vercel canary alias 已删除，`relay-lab-cn-edge-canary` 项目及其 deployments 已删除；Vercel 不再承接应用流量。
- `cn-canary.yiheng.run` DNS 已手动删除；Cloudflare 两个权威 NS 以及 `8.8.8.8`、`223.5.5.5` 均验证 A/CNAME 为 `NXDOMAIN`（`1.1.1.1` 的 CNAME 也为 `NXDOMAIN`）。
- 为保持原登录页样式，静态登录壳和登录提示 Cookie 已撤销；`/login` 已恢复原 Nuxt UI，登录按钮主题色保持 `rgb(139, 92, 246)`。footer/Worker 版本展示、自定义 favicon 和任务悬浮卡透明度作为独立 UI 提交保留。

### 同一原域名、同一登录态、同一浏览器的生产 A/B

以下均为 Cloudflare Tail 的 Worker `wallTime`，包含 Worker 内等待 D1 的时间；请求入口仍为 NRT，但 V34 的 Worker 执行与 D1 primary 都在 SIN。所有统计请求均返回 HTTP 200，Worker outcome 均为 `ok`。

| 登录态核心接口 | V23 样本 | V23 P50 / P95 | V34 样本 | V34 P50 / P95 | 成功率 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `/api/tasks` | 24 | `416 / 429 ms` | 42 | `20 / 304 ms` | `100% / 100%` |
| `/api/providers` | 21 | `334 / 350 ms` | 33 | `19 / 35 ms` | `100% / 100%` |

V34 `/api/tasks` 的 P95 `304 ms` 被发布后最初两次冷样本（`304/322 ms`）和一次历史页冷样本（`308 ms`）拉高；其余热路径样本主要为 `13–39 ms`。因此：

- `/api/tasks` P50 从 `416 ms` 降到 `20 ms`，下降约 `95%`；热路径 P95 约 `39 ms`。
- `/api/providers` P50 从 `334 ms` 降到 `19 ms`，下降约 `94%`；P95 从 `350 ms` 降到 `35 ms`。
- 这验证了核心瓶颈确实是 Worker 与 SIN D1 之间的多次跨区域往返，而不是前端资源大小或 Vercel 是否存在。

### 原域名公开链路复测

从当前可信测试网络访问原域名，入口 colo 为 NRT：

| 路径 | P50 / P95 TTFB | 成功率 |
| --- | ---: | ---: |
| `/login` | `299.8 / 393.1 ms` | `20/20` |
| `/api/auth/me` | `376.2 / 526.1 ms` | `20/20` |

这些数据说明 Worker/D1 内部链路已经显著改善；中国大陆到 Cloudflare 国际 Anycast 的公网接入波动仍是独立问题，不能通过继续修改页面样式或微调 SQL 消除。

### 批量下载回归

使用一次性合成登录态和 6 条文本任务，在 V34 生产流量下完成：登录 → 最近任务 → 多选 → 全选 6 条 → 批量下载。页面最终显示：

```text
打包下载 · 6 个任务
7/7
下载已开始
```

Tail 同时确认 6 条 `/api/tasks/:id` 全部命中 V34、HTTP 200、outcome `ok`。首批 4 个并发请求为 `320–332 ms`，第二批为 `30–42 ms`。代码中的 `concurrency = 4` 仅限制详情请求并发，不限制任务总数量；所有已选任务都会分批处理，不存在总量截断。

### 发布与回滚

当前 Wrangler 实时状态（2026-07-21）：

```text
77586b5a-83ed-4752-af72-e782af89a7a0: 100%
Deployment: 2026-07-21T05:46:32.805Z
Message: 更新机密：REGISTRATION_INVITE_CODE
```

该部署晚于 UI 恢复版本 `5972cff2-7de0-494e-bb4a-2b470cef7ddf`，属于机密更新。若需回滚，应先重新读取 `wrangler deployments status`，确认当前机密和目标版本，再使用 `wrangler versions deploy`；不要直接照搬历史 V23/V34 分流命令。

测试结束后，合成用户、Session 和 6 条任务已从远程 D1 删除，并验证用户数、Session 数和任务数均为 `0`。

<!-- FINAL-SG-ROLLOUT-END -->

排查日期：2026-07-20

## 1. 结论

本次先处理了对访问速度影响最大的关键链路，而不是继续改页面样式或做低收益资源微调：

1. Worker 固定到 `aws:ap-southeast-1`（新加坡），与 D1 primary `APAC / SIN` 同区，消除 NRT Worker 到 SIN D1 的多次跨区域往返。
2. 鉴权改为 session/user 单次 JOIN，并增加 request-scoped 复用和 5 分钟签名鉴权缓存，避免高频业务 API 重复查询 session。
3. Providers、Tasks、Refs 合并数据库读取；任务列表只返回摘要，详情按需加载。
4. 自有素材下载直接读取 R2 binding，避免 Worker 通过公网域名自回源。
5. 同步/text 任务进入 Queue 的 `run-sync` phase，不再依赖 HTTP invocation 的长时间 `waitUntil()`。
6. 批量下载保留所有已选任务，不设总量上限；仅用 `concurrency = 4` 分批加载详情。

同域名、同登录态 A/B 中，`/api/tasks` P50 从 `416 ms` 降至 `20 ms`，`/api/providers` P50 从 `334 ms` 降至 `19 ms`。因此核心应用层根因已确认并修复：此前主要是 Worker 与 D1 之间的跨区域网络往返，而不是登录页资源或 Vercel。

中国大陆到 Cloudflare 国际 Anycast 的公网入口仍可能产生额外固定成本和波动，这是独立的接入网络问题。当前选择是继续使用原域名和 Cloudflare Worker 新加坡部署，不引入 Vercel，也不以改变原页面样式换取有限收益。

验收标准：

- 核心只读 API：P50 ≤ `800 ms`，P95 ≤ `1.5 s`
- 首屏关键请求不产生多次串行跨区域 D1 往返
- 不向第三方探针泄露登录 Cookie、API Token 或 Provider Key

## 2. 当前生产状态

截至 2026-07-21，生产状态以 Wrangler 实时查询为准：

```text
Worker: relay-lab
Version: 77586b5a-83ed-4752-af72-e782af89a7a0
Traffic: 100%
Deployment 创建: 2026-07-21T05:46:32.805Z
Version 创建: 2026-07-21T05:46:31.656Z
Message: 更新机密：REGISTRATION_INVITE_CODE
```

Cloudflare / D1 状态：

- Worker placement：`targeted`，`aws:ap-southeast-1`（新加坡）
- 本地可信网络请求接入 colo：NRT（东京）
- D1 primary：SIN（新加坡），region 为 APAC，`served_by_primary = true`
- D1 Read Replication：disabled
- Worker observability：enabled
- 原域名：`https://relay.yiheng.run`
- Vercel：已彻底移除，不承接生产或 canary 流量
- `cn-canary.yiheng.run`：DNS 已删除并验证 `NXDOMAIN`

> 下文第 3 节保留了调查、候选灰度和 Vercel PoC 的历史记录。凡涉及静态登录壳、`relay_login_hint`、Vercel canary、95%/5% 分流的内容均为历史候选，**不是当前生产方案**。

## 3. 观测数据

### 3.1 生产登录态 API 基线（修改前版本）

`app_after_tls` 是从 TLS 握手完成到收到响应首字节的时间，尽量排除了 DNS、TCP 和 TLS：

| API | app_after_tls 范围 | 响应大小（curl 未压缩） |
| --- | ---: | ---: |
| `/api/auth/me` | 362–494 ms | 64 B |
| `/api/providers` | 518–656 ms | 8.6 kB |
| `/api/models` | 493–534 ms | 5.9 kB |
| `/api/tasks?limit=20` | 645–705 ms | 71.5 kB |
| `/api/tasks/stats` | 436–519 ms | 1.6 kB |
| `/api/assets` | 436–504 ms | 17.5 kB |
| `/api/cost` | 470–542 ms | 5.2 kB |

同一网络下 TLS 本身约 `132–227 ms`。因此用户看到的总请求时间通常是 `0.6–1.0 s`，其中应用等待与国际网络成本同时存在。

### 3.2 D1 SQL 执行时间

D1 Insights / query meta 显示：

- session + user JOIN：平均约 `0.38 ms`
- providers 查询：平均约 `0.56 ms`
- models 查询：平均约 `0.37 ms`
- 任务列表 SQL：平均约 `11.2 ms`（读取约 199 行）

SQL 执行时间远小于 API 的数百毫秒 TTFB。单纯继续加索引不会解决当前主要延迟。

### 3.3 中国大陆公开页面基线

Globalping measurement：`2FhCRqYkPY7vbxafl00020mwR`

该测试只访问公开 `/login`，不携带登录 Cookie，不查询 D1：

| 探针 | DNS | TCP | TLS | TTFB | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 深圳 ChinaNet | 1056 ms | 225 ms | 236 ms | 490 ms | 2009 ms |
| 长沙 China Unicom | 411 ms | 175 ms | 171 ms | 385 ms | 1143 ms |
| 北京 Tencent | 205 ms | 243 ms | 249 ms | 279 ms | 977 ms |
| 深圳 Alibaba | 293 ms | 227 ms | 287 ms | 874 ms | 1781 ms |
| 深圳 Tencent | 225 ms | 230 ms | 240 ms | 407 ms | 1102 ms |

公开页面不查 D1 仍约 `1–2 s`，且 DNS/TTFB 波动明显。因此代码优化只能解决动态 API 额外的应用层等待，不能保证大陆公网路径稳定。


### 3.3.1 公开登录页首屏负载

> **历史候选，最终未采用。** 静态登录壳与 `relay_login_hint` 已撤销，当前 `/login` 使用原 Nuxt 页面和原主题样式。

原 Nuxt `/login` 冷启动包含 1 个 HTML 和 9 个 `/_nuxt` 资源，压缩传输约 `183.7 kB`；其中主 JS 约 `139 kB` gzip。高 RTT 大陆网络会把资源发现、连接复用失败或丢包重传放大成更长的可交互时间。原全局鉴权中间件在没有 session cookie 的公开路由上仍会请求 `/api/auth/me`，又增加一次动态往返。

新静态登录壳的最终产物与 Cloudflare Assets 结果：

| 指标 | 原 Nuxt 登录页 | 静态登录壳 |
| --- | ---: | ---: |
| 首屏请求数 | 10 | 2 |
| 原始 HTML + JS | 不适用（包含 Nuxt chunks） | `12,217 B` |
| gzip-9 文件合计 | 约 `183.7 kB` | `4,431 B` |
| Brotli-11 文件合计 | 未记录 | `3,446 B` |
| Worker/D1 | Nuxt Worker + 无 cookie 时 `/api/auth/me` | 冷访客不进入 Worker、不查 D1 |

静态页保留登录、邀请注册、`?tab=register`、`?invite=...` 预填、必填/密码校验、加载态与服务端错误展示。桌面与 `390 × 844` 移动视口已完成浏览器检查，CSP/控制台无 warning 或 error。`/login` 和版本化 JS 均由 Assets 命中，JS 使用一年 immutable 缓存；没有 session 提示 cookie 的冷访问只观察到 HTML + JS 两个请求，没有 `/api/auth/me`。

已登录用户直访 `/login` 的兼容策略不是无条件调用鉴权 API，而是由登录响应设置不含身份信息的 `relay_login_hint=1` 客户端可读提示 cookie。只有存在提示时静态壳才调用一次 `/api/auth/me` 并在确认登录后跳转 `/`；logout 会清除提示，遇到 `401` 或 `200 {"user":null}` 都会删除陈旧提示。这样新访客仍保持零动态请求，同时恢复原有的已登录重定向语义。

### 3.3.2 静态登录 v5 的 Preview 与生产隔离验收

> **历史候选，最终未采用。** 静态登录壳与 `relay_login_hint` 已撤销，当前 `/login` 使用原 Nuxt 页面和原主题样式。

`wrangler.jsonc` 已启用 `"preview_urls": true`，并保留原 custom domain、Cron、Queue producer/consumer 触发器。最终候选：

```text
Version ID: 3b6b8345-dc68-4f48-a45f-c22326040fb0
Preview URL: https://3b6b8345-relay-lab.mypridelife.workers.dev
Preview alias: https://static-login-shell-v5-relay-lab.mypridelife.workers.dev
```

生产 Version Override 浏览器验收结果：

```text
status=200
title=Relay Lab · 登录
requests=/login,/login-app.0c6567e53e5b.js
api_me_requests=0
console_messages=0
```

最终 `curl` 隔离验收还确认：

- `/login` 为 `200`，`Content-Length: 6534`，只有一条 `Cache-Control: public, max-age=300, no-transform`；响应体 SHA-256 与本地 `public/login.html` 完全一致，没有 Cloudflare JSD 注入。
- `/login-app.0c6567e53e5b.js` 为 `200`，只有一条 `Cache-Control: public, max-age=31536000, immutable`；响应体 SHA-256 与本地文件完全一致。
- 两个请求均从 NRT 接入；这次验证只证明候选内容、缓存和 CSP 行为正确，不代表大陆运营商公网延迟。
- 人工设置陈旧 `relay_login_hint=1` 后，`/api/auth/me` 实际返回 `200 {"user":null}`，静态壳能够清除提示 Cookie。

### 3.3.3 v5 中国大陆公开 `/login` 复测

> **历史候选，最终未采用。** 静态登录壳与 `relay_login_hint` 已撤销，当前 `/login` 使用原 Nuxt 页面和原主题样式。

Globalping measurement：`2HEQMOqKa8Ke2rg9900020nEI`

本轮只访问公开 `/login`，不携带 Cookie、Token、Provider Key 或用户数据；仅用非敏感 Version Override Header 把请求定向到 v5：

| 探针 | DNS | TCP | TLS | TTFB | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| 广州 Tencent | 189 ms | 182 ms | 188 ms | 206 ms | 765 ms |
| 深圳 Alibaba | 183 ms | 196 ms | 204 ms | 215 ms | 798 ms |
| 北京 Tencent | 1 ms | 240 ms | 244 ms | 260 ms | 745 ms |
| 上海 Tencent | 2 ms | 203 ms | 209 ms | 231 ms | 645 ms |
| 长沙 China Unicom | 1412 ms | 159 ms | 173 ms | 307 ms | 2051 ms |

5 个探针的 TTFB 中位数为 `231 ms`，Total 中位数为 `765 ms`；4/5 探针总时间低于 `800 ms`，但长沙联通因单次 DNS 达 `1412 ms`，总时间仍为 `2051 ms`。这说明静态壳已经降低 HTML/Worker 等待，但当前样本量很小且公网 DNS/跨境路径仍有明显长尾，不能据此承诺稳定大陆 SLA。

### 3.3.4 大陆关键链路定位：实际绕到 AMS/LAX

为排除 HTML、Worker 业务代码和 D1 的影响，又复用了同一批大陆探针访问 Cloudflare 自带的 `/cdn-cgi/trace`。该端点不执行项目 Worker 业务逻辑。

Globalping measurement：`25iX5Gc4jMwHdtaWd00020nEe`

| 可用探针 | DNS | TCP | TLS | TTFB | Total | Cloudflare colo |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Alibaba | 230 ms | 248 ms | 257 ms | 250 ms | 985 ms | AMS |
| Tencent #1 | 1020 ms | 245 ms | 249 ms | 245 ms | 1760 ms | AMS |
| Tencent #2 | 66 ms | 193 ms | 203 ms | 197 ms | 659 ms | AMS |
| China Unicom | 214 ms | 159 ms | 171 ms | 161 ms | 706 ms | LAX |

结论：项目域名的大陆流量没有接入近邻 Cloudflare POP，而是绕到阿姆斯特丹或洛杉矶。`TCP + TLS` 两阶段本身已约 `330–505 ms`；首次 DNS 未命中时还会叠加几十毫秒到 1 秒以上。

TCP traceroute measurement：`2pJKZe1rLvQD7ln6500020nEg`

- 三个电信/云探针在进入国际链路前 RTT 约 `3–7 ms`，跨境后的 `202.97.*`/Cloudflare 跳点立刻升至约 `152–245 ms`。
- 联通探针到 Cloudflare Anycast 终点约 `162–173 ms`。
- 这证明主要延迟跃升发生在大陆出口到 Cloudflare 国际接入之间，不在 Worker handler 或 D1 SQL。

另外用相同探针访问 `www.cloudflare.com/cdn-cgi/trace`（measurement `29lGzYzFz94uyF8ka00020nEn`），三个可用探针也全部进入 LAX，TCP 为 `162–261 ms`。因此这不是 `relay.yiheng.run` 某一条 DNS 记录或某个 Worker Version 的特例，而是当前大陆网络到 Cloudflare 国际 Anycast 的接入路径。

### 3.3.5 `workers.dev` 不能作为大陆替代入口

同探针对 Preview alias `static-login-shell-v5-relay-lab.mypridelife.workers.dev` 的 measurement 为 `2PDufF0mWyAgwsItY00020nEd`：一个探针离线，其余四个全部超时。公共解析器也给出互相冲突的结果：

```text
1.1.1.1:      104.21.77.92 / 172.67.206.114
223.5.5.5:    199.59.149.208
119.29.29.29: 157.240.3.50
```

后两组地址不是正常 Workers Preview 解析结果，表明 `workers.dev` 在大陆 DNS 环境存在污染/劫持风险。它只能用于隔离验收，不能作为大陆生产加速入口。

### 3.3.6 Vercel 自定义域名入口 PoC：大陆稳定进入 SIN

CDN 对照中，CloudFront 仍绕到 FRA/SFO，Fastly 虽能进入 NRT/SIN/ITM 但 DNS 长尾明显，Akamai 的 TCP/TLS 仍高；Vercel 的 DNS-only 自定义域名表现最好。已有 `x.yiheng.run`、`running.yiheng.run`、`yiheng.run` 在同批大陆探针上均稳定显示 `x-vercel-id: sin1::...`，其中 `x.yiheng.run` 的 TCP 为 `43–81 ms`、TLS 为 `66–153 ms`。

为避免 `.vercel.app` 在大陆的 DNS 污染，PoC 使用自定义域名作为浏览器入口；Vercel 在 SIN 终止客户端连接，并将动态请求 external rewrite 到固定 Worker Version：

```text
大陆浏览器
  -> DNS-only Vercel 自定义域名
  -> Vercel SIN
     -> /login + hashed JS：Vercel 静态文件
     -> /api/*：固定 Cloudflare Worker Version（SIN）
        -> D1 / R2 / 上游 Provider
```

Canary deployment：

```text
Vercel deployment: dpl_DLWUTNtFUne58pPwd7a1MZJjGkJn
Vercel URL:        relay-lab-cn-edge-canary-8wvjic17d-gyhs-projects-053af9a7.vercel.app
Worker version:    ca985f80-1b03-4ef6-8ac8-1e290c6db4ac（0% Preview，未进入生产分流）
```

`x.yiheng.run` 只在分钟级测试窗口临时映射到 canary，并通过 shell `trap` 自动恢复；测试结束后已复核根路径恢复为原项目的 Vercel `404 NOT_FOUND`。所有 Globalping 请求均为匿名 GET，没有 Cookie、Token、Provider Key 或生产用户数据。

首轮测量：

```text
/cdn-cgi/trace: 2X4EOXwSTqHAyZrKX00020nFk
/login:         2UaSIKkQcT4ay2xF900020nFk
/login JS:      2rVU2iPQImlDuhPON00020nFk
/api/auth/me:   29iRPmzMayW2iDvCG00020nFk
```

| 路径 | 在线样本 | P50 Total | max Total | 关键链路证据 |
| --- | ---: | ---: | ---: | --- |
| `/login` | 4 | 467 ms | 856 ms | `sin1`、`server: Vercel`、无 `CF-RAY` |
| hashed login JS | 4 | 484 ms | 944 ms | `sin1`、`server: Vercel`、无 `CF-RAY` |
| `/api/auth/me` | 4 | 625 ms | 753 ms | Vercel `sin1`，Worker `CF-RAY ...-SIN` |

随后对 `/login` 与匿名 `/api/auth/me` 各连续复测三轮；每轮四个在线大陆探针，共 12 个有效样本：

```text
/login:      2rOj9X5tbqb4oy6Oc00020nFn
             2xyo8l8Lbhca0dNFp00020nFn
             29BGM3m6Igggt8GDh00020nFo
/api/auth/me: 2STNbuTA0Fsm4PVRX00020nFn
              2E38GEdYdYuRa7Ps200020nFn
              2W2MU1bGX2ZvAXQ2000020nFo
```

| 路径 | P50 Total | max Total | P50 first-byte 阶段 | 结果 |
| --- | ---: | ---: | ---: | --- |
| `/login` | 229 ms | 551 ms | 约 69 ms | 12/12 为 Vercel cache HIT，全部 `sin1` |
| `/api/auth/me` | 408 ms | 649 ms | 约 146 ms | 全部 Vercel `sin1` → Worker `SIN` |

把首轮与连续复测合并后，`/login` 16 个在线样本的 P50/max 为约 `285/856 ms`；匿名 `/api/auth/me` 16 个在线样本的 P50/max 为约 `445/753 ms`。这已经达到入口 PoC 的 `/login P50 ≤ 500 ms、max/P95 ≤ 1.2 s`，动态匿名 API 的 P50 也低于 `500 ms`。

剩余长尾主要来自冷 DNS：同一自定义域名的 CNAME TTL 为 `600 s`，Vercel A 记录 TTL 为约 `300 s`，个别公共探针 DNS 阶段仍出现 `237–693 ms`。但缓存命中后的 TCP/TLS 与静态 first-byte 已显著低于 Cloudflare AMS/LAX 直连；浏览器加载登录 JS 时还会复用同一域名的 DNS 与 HTTP/2 连接，因此独立 JS 探针是偏保守估计。

### 3.3.7 Vercel 可信登录态 E2E 与 Worker → R2 核心链路修复

为验证 P1 不只是匿名测速可用，使用随机一次性生产合成用户、随机存储命名空间、假 Provider Key、`.invalid` Provider URL 和 1×1 PNG，在可信本地环境通过 Vercel canary 完成登录态 E2E。测试凭据未输出到公开探针或日志；临时 `x.yiheng.run` 别名由 `trap/finally` 恢复，D1/R2 数据在退出时做防御性清理。

首次回归发现：

```text
GET /api/assets/download?... -> 502 拉取失败
```

该错误同时出现在“Vercel → 固定 Worker”和“直接访问固定 Worker”两条路径，因此不是 Vercel rewrite 或请求流转发问题。根因是下载接口在完成所有权校验后，又从 Worker `fetch()` 自有 `R2_PUBLIC_BASE` 公网域名，形成一次不必要的同区公网自回源：

```text
Worker -> assets.relay.yiheng.run -> Cloudflare/R2 公网入口
```

修复后，自有对象 URL 先转换为 R2 key，再通过 `useBucket().get(r2Key)` 直接读取 binding 并流式返回；只有外部 Provider 结果 URL 继续走受限制的公网 fetch。这样同时移除了 DNS/TLS/HTTP 网络跳转并修复了 `502`。修复版本为 `ca985f80-1b03-4ef6-8ac8-1e290c6db4ac`，只上传为 Preview，未改变生产 `95% / 5%` 分流。

修复后的可信 E2E 已验证：

- `/login` 和哈希 JS 由 Vercel 直接提供，无 `CF-RAY`；
- 登录签发 `seedance_session`、`relay_auth_cache`、`relay_login_hint`，均为 `Secure; Path=/; SameSite=Lax`，且没有错误的 `Domain=workers.dev`；
- `/api/auth/me`、Providers GET/POST/PATCH/DELETE、Tasks 空列表、multipart 上传、Assets 列表均通过；
- R2 公网对象、Vercel 代理下载、直接 Worker 下载的字节与哈希一致；
- 删除素材后 D1 记录消失且 R2 公网 URL 不再返回 200；
- logout 清除 Cookie，后续 `/api/auth/me` 恢复匿名；
- 动态 `/api/*` 始终为 `private, no-store`，未出现认证响应 Vercel cache HIT，也没有重定向泄露 `workers.dev`；
- 清理审计为零残留：合成 D1 行为 `0`，临时 R2 对象已删除，`x.yiheng.run` 已恢复原项目 `404 NOT_FOUND`。

本地链路进入 Vercel `hnd1`、Worker `NRT`，因此其绝对耗时不能代替大陆结论；大陆 `sin1` 入口仍以前述匿名公共探针为证。本轮证明的是关键业务兼容性，不是大陆登录态性能。代码审查确认 `/api/tasks/run` 在任务落库并发 Queue 消息或注册 `waitUntil()` 后就返回，不会等待 Provider 的 `60 s / 5 min` 调用才向 Vercel 发送首字节，因此 Vercel external rewrite 的 `120 s` 不是当前任务提交响应的主要风险。真正需要优先修复的是同步/text 任务仍依赖 HTTP invocation 的 `waitUntil()` 后台执行；HTTP `waitUntil()` 生命周期不应承载多分钟业务任务，而同步 Provider 超时配置为 `5 min`，长生成可能在后台被回收并永久停留 `running`。因此同步/text 任务已改为进入现有 Queue consumer，后续再用受控慢上游做回归。其余核心门禁是源站绕过保护、完整 Host/Forwarded/IP 语义，以及自管大陆三网的可信登录态复测。

### 3.4 前序 API 候选生产登录态对照

前序 API 候选先以 `0%` 挂入当时的 Deployment，通过以下版本覆盖头定向访问，不把普通用户流量切到候选：

```text
Cloudflare-Workers-Version-Overrides: relay-lab="86c98efb-709d-4db6-8cb3-272f75044e62"
```

使用可立即删除的临时诊断账号完成登录；Cookie 仅保留在本机进程内，未输出到日志或第三方探针。每个接口采样 20 次，每次新建 TLS 连接，旧版与候选交替请求以减小时间段偏差：

| API / 版本 | P50 TTFB | P95 TTFB | 状态 | 鉴权路径 |
| --- | ---: | ---: | --- | --- |
| Providers 旧版 | 660 ms | 743 ms | 20/20 为 200 | D1，且每次重发 Cookie |
| Providers 候选 | 358 ms | 423 ms | 20/20 为 200 | `signed-cache` |
| Tasks 旧版 | 650 ms | 824 ms | 20/20 为 200 | D1，且每次重发 Cookie |
| Tasks 候选 | 363 ms | 509 ms | 20/20 为 200 | `signed-cache` |

补充结果：

- 候选登录：TTFB `552 ms`，同时签发 `seedance_session` 与 `relay_auth_cache`。
- `/api/auth/me`：TTFB `329 ms`，`Server-Timing` 为 `auth;dur=83.0;desc="fresh-d1"`。
- 候选 Providers/Tasks 的 auth timing 均为 `0.0 ms`、`desc="signed-cache"`。
- 候选 40 次业务请求的 `Set-Cookie` 总数为 `0`；旧版对应 40 次请求均重发 Cookie。
- 所有请求从 NRT 接入；候选 handler 的单次 D1 阶段约 `77–84 ms`。
- 临时诊断用户和 session 已删除，复核剩余数量为 `0`。
- 进入 5% 灰度后又完成 100 次定向 smoke：`/login`、`/api/auth/me` 各 25/25 正常，未登录 Providers/Tasks 各 25/25 正确返回 401；候选错误 tail 无异常事件。

该结果证明应用层优化达到暂定指标，但它是可信本地网络的登录态数据，不替代多运营商大陆公网测试。

### 3.5 5% 灰度后复测

候选创建约 1 小时后，再使用隔离临时诊断账号对同一组接口各采样 20 次；测试结束后删除临时用户和 session，并复核均无残留：

| API / 版本 | P50 TTFB | P95 TTFB | handler D1 P50 / P95 | 状态 |
| --- | ---: | ---: | ---: | --- |
| Providers 旧版 | 668 ms | 771 ms | 无埋点 | 20/20 为 200，20 次重发 Cookie |
| Providers 候选 | 351 ms | 524 ms | 78 / 88 ms | 20/20 为 200，全部 `signed-cache` |
| Tasks 旧版 | 600 ms | 675 ms | 无埋点 | 20/20 为 200，20 次重发 Cookie |
| Tasks 候选 | 348 ms | 402 ms | 81 / 92 ms | 20/20 为 200，全部 `signed-cache` |

补充观察：

- `/api/auth/me` fresh D1 的 TTFB 为 `522 ms`，D1 阶段 `84 ms`。
- 候选业务请求未重发 `Set-Cookie`，接入 colo 仍为 NRT。
- `Cf-Placement: local-NRT` 表明此次请求没有被 Smart Placement 转发到远端；handler 的 D1 阶段仍约 `78–92 ms`。当前收益主要来自减少/合并 D1 往返，而不是 Worker 已迁移到 D1 primary 附近。
- 对未携带 Cookie 的 `/api/auth/me` 发出 200 次普通流量请求，候选命中 `11` 次、旧版命中 `189` 次，分布与 5% 灰度相符，200/200 均为 200。
- 约 50 秒候选 `status=error` 实时 tail 未观察到错误事件；这只能作为短窗口 smoke，不能替代持续可观测性。

### 3.6 大陆公开页候选复测

使用 Globalping 相同的 5 个中国大陆探针，仅携带非敏感的 Version Override Header 访问公开 `/login`，未发送 Cookie、token 或 Provider Key：

```text
候选 measurement: 2eVafcjYX8544IyVF00020myl
旧版 measurement: 2ew0kOWw7GdaukGAh00020myo
```

候选结果：5/5 为 200，Total 中位数 `1302 ms`、范围 `1076–1584 ms`；TTFB 中位数 `457 ms`、范围 `424–706 ms`。同一批探针的旧版 Total 中位数 `1219 ms`、范围 `823–2860 ms`。两轮都出现明显 DNS/TLS 波动，且探针流量的 Cloudflare colo 为 AMS；该样本不能证明候选改善了公开页网络，反而再次说明大陆到国际 Cloudflare 网络的路径和解析波动是独立瓶颈。

## 4. 根因

### 4.1 已登录请求存在多次串行 D1 往返

修改前，受保护 API 会依次：

1. 根据 token 查询 `sessions`
2. 根据 `user_id` 查询 `users`
3. `touchSession()` 再查一次 `sessions`
4. API handler 再执行自己的 D1 查询

`/api/providers` 又串行查询 providers 和 models，最多形成 5 次先后发生的数据库网络往返。每条 SQL 不到 1 ms，但 NRT ↔ SIN 的往返等待会累计。

### 4.2 Session cookie 被无意义地重写

旧 `touchSession()` 在无需刷新有效期时仍返回旧 expiry，middleware 因此在每个请求响应里发送 `Set-Cookie`。这不是数百毫秒延迟的主因，但增加响应头和无意义的浏览器状态更新。

### 4.3 Worker 与 D1 primary 不在同一位置

旧配置没有 placement。Worker 跟随访问入口执行，而 D1 primary 在另一 colo。对于数据库密集型 API，把 Worker 放在主要后端附近往往比让每条 SQL 跨区域访问更快。

### 4.4 列表响应包含详情级大字段

旧 `/api/tasks` 返回 request/response payload 和 refs 等详情字段。生产 `limit=20` 已约 71.5 kB，首页默认 60 条、历史页最多 300 条，带来额外序列化、传输、解压和前端解析成本。

### 4.5 中国大陆流量被国际 Anycast 导向 AMS/LAX

公开页面和 `/cdn-cgi/trace` 均证明，即使没有 D1 查询，大陆请求仍进入 AMS/LAX，并承担约 `159–248 ms` TCP、`171–257 ms` TLS 以及不稳定 DNS。相同探针对 Cloudflare 官网也进入 LAX，说明这不是换 Worker Version、换 `workers.dev` 子域或改一条普通 DNS 记录能够解决的问题。必须让大陆客户端先接入境内或香港等近邻节点，再通过受控骨干/优化线路访问 Worker。

## 5. 当前未提交代码优化

### 5.1 首次鉴权合并为一次 D1 JOIN

- session、user、avatar、nickname、expiry 使用一次 indexed JOIN 读取。
- `event.context` 在同一请求内复用鉴权结果。
- `touchSession()` 使用已读取的 expiry，不再重查 session。
- 只有跨过 24 小时刷新阈值时才更新 D1 并发送 session cookie。
- session 已被删除时，只有 `UPDATE ...` 实际修改了行才允许续期，避免已撤销客户端无限自我续期。

### 5.2 5 分钟短时签名鉴权缓存

新增 HttpOnly Cookie：`relay_auth_cache`。

- HMAC-SHA256 签名。
- 绑定原 session token 的 SHA-256 fingerprint，不能脱离 session cookie 单独使用。
- 有效期最多 5 分钟，且不会超过 session expiry。
- `/api/auth/me` 始终 fresh D1，返回完整头像/资料并重新签发缓存。
- 后续 providers、tasks 等业务 API 验证签名后跳过 session JOIN。
- 缺少或长度不足 32 字符的 `SESSION_CACHE_SECRET` 时自动 no-op，安全回退 D1 鉴权。
- profile 修改后主动清除缓存，避免 nickname 短期陈旧。
- logout 清除 session cookie 和签名缓存 cookie。

此设计明确接受：**通过后台或其他设备撤销 session 后，已持有有效签名缓存的客户端最多仍可访问约 5 分钟**。正常浏览器 logout 会立即清除两个 cookie。对更严格的强制撤销要求，应改用每次查 D1、Durable Object/KV 撤销表，或进一步缩短缓存 TTL。

启用该优化前必须配置生产 Secret：

```text
SESSION_CACHE_SECRET
```

不要把 Secret 写入 `wrangler.jsonc`、Git、日志或命令历史。Secret 变更会创建 Worker version；建议用独立 staging 环境，或先用 `wrangler versions secret put SESSION_CACHE_SECRET` 生成未部署版本，再明确验证和分流。

### 5.3 handler D1 往返合并

- providers + models 使用 `DB.batch()`，从两个串行 await 变成一次数据库往返。
- task refs 从先查关联、再查 assets，改为一次 indexed JOIN。

### 5.4 任务列表/详情拆分

- `/api/tasks` 只返回卡片、状态和结果摘要所需字段。
- `request_payload`、`response_payload`、refs 等详情在用户点击任务或重试时通过 `/api/tasks/:id` 懒加载。
- 首页默认任务数量从 60 降到 30。
- 轮询仍使用摘要，并在前端保留已加载的完整详情。

### 5.5 Smart Placement

`wrangler.jsonc` 已加入：

```jsonc
"placement": {
  "mode": "smart"
}
```

Smart Placement 根据真实请求和绑定访问学习放置策略，不应只测部署后第一分钟。官方说明分析可能需要最多约 `15 分钟`，且需要来自多个位置的持续流量。候选运行约 1 小时后的实测仍为 `Cf-Placement: local-NRT`，D1 handler 阶段约 `78–92 ms`，说明当前请求没有被远程放置；鉴于业务 API 已被压缩到单次 D1 往返，远程转发也未必比本地执行显著更快。继续保留 Smart Placement 观察，但不把它计入当前已实现的性能收益。

### 5.6 Server-Timing

为生产验收增加了不包含敏感信息的 `Server-Timing`：

- middleware：`auth;desc="signed-cache"`、`auth;desc="d1"`，刷新时为 `signed-cache+refresh`
- `/api/auth/me`：`auth;desc="fresh-d1"`
- `/api/providers`：`app;desc="providers"`
- `/api/tasks`：`app;desc="task-list"`

这些头可以确认慢请求是在鉴权、handler 还是客户端网络阶段，不包含 Cookie、token、SQL 参数、Provider Key 或响应内容。


### 5.7 公开 `/login` 静态轻量壳（历史候选，最终未采用）

该候选曾用于验证减少首屏请求数的收益，但它改变了原登录页实现和视觉表现。最终方案明确撤销：删除静态 HTML/JS、`relay_login_hint` 和相关 Assets headers，恢复原 Nuxt 登录页。此候选不进入本次 Git 提交，也不属于当前生产方案。

## 6. 隔离本地 Worker 验证

使用临时本地 D1/R2、全部 migrations 和临时测试数据运行 Wrangler Worker；未访问或修改生产数据。测试 task 的 request/response payload 各约 20 kB。

结果：

```text
public_login_status=200
unauth_providers_status=401
login_status=200
login_cookie_names=relay_auth_cache,seedance_session  # 此快照早于 relay_login_hint 引入

providers_d1_status=200
providers_d1_timing=auth;dur=1.0;desc="d1", app;dur=1.0;desc="providers"

providers_cache_status=200
providers_cache_timing=auth;dur=0.0;desc="signed-cache"|app;dur=1.0;desc="providers"

auth_me_status=200
auth_me_timing=auth;dur=1.0;desc="fresh-d1"
auth_me_full_profile_ok=true

task_list_status=200
task_list_bytes=787
task_list_timing=auth;dur=0.0;desc="signed-cache"|app;dur=1.0;desc="task-list"
task_list_summary_ok=true

task_detail_status=200
task_detail_bytes=40823
task_detail_full_payload_ok=true

revoked_cache_window_status=200
replacement_set_cookie_count=0
revoked_without_cache_status=401
```

验证结论：

- 上面的 Cookie 名称快照来自 `relay_login_hint` 引入之前；后续 Vercel canary 的可信合成登录态 E2E 已实测当前实现同时签发 `seedance_session`、`relay_auth_cache`、`relay_login_hint`，属性均符合预期。该结果对应零流量 Preview `7648d611-b6ac-40ea-bb67-4a18c96eed1b`，不是对生产 v5 分流的重新执行。
- session-only 请求先走 D1，签名缓存命中后鉴权不再访问 D1。
- 合成任务列表为 787 B，完整详情为 40,823 B，列表/详情拆分有效。
- session 在 D1 被删除后，当前签名缓存仍可在约定的 5 分钟窗口内使用，但不会获得替代 Cookie，也不会无限续期。
- 移除签名缓存后，已撤销 session 立即返回 401。

### 6.1 生产隔离合成用户端到端回归（2026-07-20）

候选版本已完成稳定通道的生产隔离回归。测试使用随机临时账号、1×1 PNG、合成 prompt 和假 API key；没有读取或发送现有用户的 Cookie、Token、Provider Key 或业务数据。所有应用 HTTP 请求均通过：

```text
Cloudflare-Workers-Version-Overrides: relay-lab="86c98efb-709d-4db6-8cb3-272f75044e62"
```

已验证通过的路径：

- 登录、`relay_auth_cache` 签发、`/api/auth/me` fresh D1；
- R2 上传、公开对象读取；
- 同步任务提交、终态轮询、refs/segments 关联和详情 payload；
- 任务列表摘要不泄露详情级 payload/refs；
- 两个 Queue 异步失败路径（含 retry-equivalent）均进入 `failed` 并保留非空上游错误；
- profile cache invalidation、并发 detail hydration 和 logout；
- 测试结束后的清理审计：`users=0, sessions=0, tasks=0, assets=0`。

最终回归结果为 `ok=true`，10 项业务检查全部通过。27 个业务请求的端到端 TTFB P50/P95/max 为 `258/677/794 ms`；请求均显示 `Cf-Placement: local-NRT`，warm 鉴权请求显示 `auth;dur=0.0;desc="signed-cache"`。实时 Worker tail 汇总为 `72` 条 `outcome: ok`，无非 OK 行、无 exception/error；tail 中同时观察到 `4` 个 Queue batch 记录。由于渐进发布时 Queue consumer 可能由旧版本处理，HTTP Version Override 不用于断言 Queue consumer 的版本路由，但该问题不影响本轮业务回归通过。

稳定通道使用了临时 Workers.dev 出口代理，仅接受随机探针 Header，测试结束后已删除代理 Worker 和本地凭据。此前本机直接访问生产域曾触发 Cloudflare Managed Challenge；该 403 未进入 Worker，不能作为应用错误统计。生产回归仍不替代真实存量用户浏览器 ZIP 落盘验证，也不替代电信/联通/移动等多运营商大陆登录态复测。

首次运行还发现本地 Wrangler `d1 execute --file --json` 会把文件上传进度行写入 stdout，导致回归脚本误解析；脚本已改为 `--command --json`，临时用户也已清理并复核为零。

## 7. 发布前检查

当前已经完成：

```text
pnpm build
npx wrangler deploy --dry-run
git diff --check
```

`nuxi typecheck` 暂时不能作为发布门禁，因为项目未安装 `vue-tsc`。`tsc --noEmit` 还有项目原有类型错误，包括缺失 `@types/node` 和 strict 数组索引问题；本次新增的 providers batch 和前端 auth user 类型问题已修复，生产构建成功。

发布门禁执行状态：

1. 已创建不接普通流量的候选 Worker Version。
2. 已配置独立 `SESSION_CACHE_SECRET`，上传用临时文件已删除。
3. 已完成本地隔离回归、生产 Version Override 登录态回归和 20 次/接口延迟对照。
4. 已确认签名缓存 Cookie、session Cookie、Provider Key 和 Token 未进入第三方探针。
5. 已在 0% 回归通过后进入 5% 渐进发布，而非直接 100% 切换。
6. 已完成短窗口候选错误 tail、200 次普通流量分流检查、灰度后第二轮延迟对照和稳定通道生产隔离 E2E；tail 无 exception/error，E2E 的 10 项检查全部通过。
7. 历史候选静态登录壳曾通过 `node --check`、`git diff --check`、`pnpm build`、本地 Cloudflare Assets 命中检查、Preview URL、生产 Version Override、桌面/移动浏览器交互和 CSP 检查，并曾进入 `5%` 灰度；最终因保持原页面样式而撤销。

## 8. 生产发布后验收

### 8.1 测试方法

1. 发布后持续产生常见 API 流量，等待 Smart Placement 学习至少 `15–30 分钟`。
2. 从可信本地/自管大陆探针发起登录态请求；**不得把登录 Cookie 交给 Globalping 等第三方服务**。
3. 以下接口每个至少采样 20 次：
   - `/api/auth/me`
   - `/api/providers`
   - `/api/tasks?limit=20`
   - `/api/tasks/stats`
4. 同时记录：
   - DNS、TCP、TLS、TTFB、Total
   - P50、P95
   - `cf-ray` 及 colo
   - `Server-Timing`
   - `Content-Length`、`Content-Encoding`
   - Workers Wall time 与 CPU time
5. 比较 cache cold 和 cache warm：
   - `/api/auth/me` 应显示 `fresh-d1`
   - 紧随其后的业务 API 应显示 `signed-cache`

### 8.2 通过条件与当前结果

- [x] 核心 Providers/Tasks API P50 ≤ `800 ms`、P95 ≤ `1.5 s`
- [x] cache warm 业务请求的鉴权不再访问 D1
- [x] providers/models 不再产生两个串行数据库往返
- [x] task list 不包含详情级大 payload/refs
- [x] 0% 定向回归、5% 分流检查、第二轮延迟复测及短窗口错误 tail 未发现登录/鉴权错误
- [x] 生产隔离合成用户已覆盖上传、同步任务、refs、任务摘要、两个 Queue failure/retry-equivalent 路径、并发 detail hydration、profile cache invalidation 和 logout，且清理审计为零残留
- [ ] 在真实存量用户上继续观察上传、任务提交/轮询、重试和批量下载
- [x] 历史候选静态登录壳曾把冷首屏从 10 个请求、约 `183.7 kB` 压缩资源降到 2 个请求、约 `4.4 kB` gzip
- [x] 历史候选静态登录壳曾完成 Preview 与灰度验证；最终已撤销，未进入当前方案
- [x] 历史静态壳候选的匿名浏览器与 hint 清理回归曾通过；当前已恢复原 Nuxt UI，不再签发 hint Cookie
- [x] Vercel canary + 零流量 Preview `7648d611-b6ac-40ea-bb67-4a18c96eed1b` 已完成可信登录态、三 Cookie、Providers CRUD、multipart 上传、R2 下载/删除和 logout E2E，清理审计为零残留
- [x] 已修复 Worker 通过自有 R2 公网域名自回源导致的下载 `502`，自有对象改为直接读取 R2 binding
- [x] 已用 5 个公开大陆探针定向复测 v5 `/login`，未附带登录 Cookie；TTFB 中位数 `231 ms`、Total 中位数 `765 ms`，但 DNS 长尾仍使单点达到 `2051 ms`
- [x] 代码审查确认任务 POST 在 Queue send / `waitUntil()` 注册后返回，不等待 Provider 生成完成，正常情况下不会撞 Vercel external rewrite 的 `120 s` 首字节上限
- [x] 同步/text Provider 已从 HTTP `waitUntil()` 迁入 Queue consumer；隔离的临时 Queue/Worker + 受控 30 秒 text 上游验证：任务 POST `1.52 s` 返回，约 30 秒后进入 `succeeded`，`result_text` 与 `latency_ms` 正确落库，且合成 D1 数据和临时资源已清理
- [ ] 验证源站绕过保护与 Host/Forwarded/IP 语义
- [ ] 完成至少一轮可信、自管的电信/联通/移动登录态公网复测；公开页的国际网络成本仍可能超过 `1.5 s`

若公开页或静态资源仍普遍超过 `1.5–2 s`，而 `Server-Timing` 很低，则瓶颈已主要转移到大陆公网接入，不应继续通过微调 SQL 追逐网络延迟。

## 9. 后续方案

### 9.1 D1 Read Replication + Sessions API

当前 Read Replication 为 disabled。启用后必须使用 D1 Sessions API 才能利用副本；无 bookmark 的新 session 默认 first-primary，容忍陈旧的首次读取可显式使用 `first-unconstrained`。

不要把所有查询无差别切到 replica：

- session/auth、刚写完立即读、任务状态：primary 或严格 bookmark
- 写后读：同一个 D1 session/bookmark
- providers/models 等低一致性只读数据：可评估附近 replica

这属于第二阶段，应该在当前往返消除和生产测量之后再做。

### 9.2 历史任务 cursor pagination

首页已降至 30 条摘要，但历史页仍可能取 300 条。下一步应改为 cursor pagination / infinite scroll，而不是简单丢弃旧历史。

### 9.3 中国大陆网络方案（按实际收益排序）

当前 Cloudflare Zone 是 `Free Website`，没有 China Network。结合测得的 AMS/LAX 接入，下面只保留能改变关键链路的方案。

#### P0：Cloudflare China Network + Global Acceleration PoC

这是与现有 Worker 架构最接近、也最可能稳定改善三网接入的正式方案：

- 官方要求 Cloudflare **Enterprise**，并额外购买 China Network；域名需要 ICP 备案/许可并经过 JD Cloud 内容审核。
- 截至 2026-07-20，China Network 当前“可用产品”页面的 Developer Services 明确列出 Workers、Workers KV、Assets 和 R2，但**没有列出 D1**；R2 不能在大陆创建，只能通过 Global Acceleration 延伸。因此必须向 Cloudflare 书面确认 Worker + D1 binding 的实际拓扑和支持范围。
- CDN Global Acceleration 是 China Network 的附加能力，可作为大陆节点访问境外 D1/服务的跨境通道候选，但不能在缺少 PoC 数据时推断其延迟。

因此不能只购买 China Network 就直接承诺当前 D1-backed API 变快。PoC 必须验证：

1. `relay.yiheng.run` 在电信/联通/移动是否进入大陆 JD Cloud 节点，而不是 AMS/LAX。
2. 中国节点上的 Worker 是否能使用现有 D1 binding；若不支持，Global Acceleration 回到境外 API/D1 的 P50/P95 是多少。
3. 登录、上传、任务轮询、R2 下载的完整链路是否都满足门槛。

#### P1（历史 PoC，最终未采用）：Vercel DNS-only 自定义域名 + 静态/动态拆分

> **历史 PoC，最终未采用。** Vercel 项目、alias 和 canary DNS 均已删除；以下仅保留当时的验证记录。

该方案当时已经用大陆公开探针验证，且不要求先购买 Cloudflare Enterprise/China Network：

```text
大陆浏览器
  -> cn-canary.yiheng.run（DNS-only CNAME 到 Vercel）
  -> Vercel SIN
     -> 静态登录壳和 hashed assets
     -> 动态请求 external rewrite 到固定 Worker Version
  -> D1 / R2 / 上游 Provider
```

它不是为了再省几 KB，而是直接消除两段核心损耗：

1. 浏览器不再被 Cloudflare Anycast 导向 AMS/LAX，而是在 SIN 完成 TCP/TLS。
2. `/login` 不再经历 Vercel SIN → Worker SIN 的第二次边缘回源。

当前 `cn-canary.yiheng.run` 已添加到 Vercel 项目，但 Cloudflare DNS 记录尚未创建；所需记录为 DNS-only CNAME 到 Vercel 提供的目标。现有 Token/Wrangler OAuth 只有 Zone Read，没有 DNS Edit，因此不能自动落 DNS。

可信环境兼容性验证已经通过的部分：

- 登录 POST、三类 Cookie 属性、`/api/auth/me`、退出和匿名恢复；
- Providers GET/POST/PATCH/DELETE、Tasks 空列表、multipart 上传、R2 读取、下载流和删除；
- 动态 API `private, no-store`、无认证缓存 HIT、无 `workers.dev` 重定向泄露；
- Worker → 自有 R2 下载已由公网自回源改为 binding 直读，原 `502` 已消除。

在任何生产灰度前仍必须补齐的核心门禁：

- 任务提交路由已通过受控 30 秒慢上游回归，POST 在 `1.52 s` 返回，不等待 Provider 完成；后续需保留此回归，防止等待重新进入请求关键路径；
- 同步/text Queue 的成功终态落库已通过；仍需补 provider 超时、瞬时失败重试、DLQ/僵尸回收验证；
- Host、Forwarded/IP、CORS 和源站绕过保护；
- 固定 Worker Version 的升级、回滚和失效流程；
- 自管大陆电信/联通/移动的可信登录态复测。

通过后只对独立 canary 子域或小比例用户灰度，不直接把 `relay.yiheng.run` 全量切换。静态资源可在 Vercel 缓存，`/api/*`、认证页面和业务响应必须保持 `private, no-store` 或等价策略。

#### P2：Vercel 兼容性不通过时，再做香港优化线路反向代理

如果 Vercel 的上传流、长请求、Cookie 或回源限制无法满足业务，再购买一台或一项具备大陆三网优化线路的香港入口，反代到独立 Cloudflare Worker 源站域名：

```text
大陆浏览器
  -> relay.yiheng.run（香港优化入口）
  -> origin-relay.yiheng.run（同一个 Cloudflare Worker）
  -> D1 / R2 / 上游 Provider
```

上线前必须做到：全量透传方法、请求体、响应流与 `Set-Cookie`；上传链路流式转发；动态接口禁用缓存；源站使用随机鉴权 Header、mTLS 或防火墙约束；测试子域 0% PoC 通过后再小流量灰度。

验收线保持不变：

- `/login` Total：三网 P50 `≤ 500 ms`、P95 `≤ 1.2 s`。
- 已登录 Providers/Tasks：三网 P50 `≤ 800 ms`、P95 `≤ 1.5 s`。
- 相比当前 Cloudflare 直连，TCP+TLS P50 至少下降 `200 ms`。
- 不能出现 `workers.dev` 式解析失败。

#### P3：数据层只做第二阶段

当前业务 API 的 D1 handler 阶段约 `78–92 ms`。D1 Read Replication + Sessions API 最多主要改善这一段，无法消除用户到 AMS/LAX 的数百毫秒和 DNS 长尾。等 P0/P1/P2 把接入路径修正后，再对 providers/models 等弱一致性读启用 `first-unconstrained`；session/auth、任务状态和写后读继续用 primary/bookmark。

#### 明确排除的低收益或错误方向

- **继续压登录页几 KB、把 JS 内联**：最多减少一个请求，不能改变 AMS/LAX 路由，已暂停。
- **把生产入口换成 `workers.dev`**：同探针 4/4 超时且存在 DNS 污染，明确排除。
- **仅开启 Argo Smart Routing**：官方定位是把 Cloudflare 网络内流量更高效地送到 origin；当前应用本身就是 Worker，没有传统外部 origin，它不会把大陆用户的首个 Cloudflare 接入点从 AMS/LAX 拉回香港/大陆。
- **仅依赖 Smart Placement**：它只改变 fetch handler 的执行位置以靠近数据库/后端，静态资源仍在请求入口附近提供，也不改变用户到 Cloudflare 的入口。
- **只换公共 DNS 或提高 TTL**：可降低部分 DNS 冷查询，但 TCP/TLS 到 AMS/LAX 仍在；只能作为辅助，不是核心修复。
- **无证据迁移 D1 APAC location hint**：APAC 不保证 NRT，且当前 D1 仅约 `80–90 ms`，收益小于入口治理。

官方参考：

- [Cloudflare China Network get started](https://developers.cloudflare.com/china-network/get-started/)
- [China Network available products](https://developers.cloudflare.com/china-network/reference/available-products/)
- [China Authoritative DNS](https://developers.cloudflare.com/china-network/concepts/china-dns/)
- [China Network Global Acceleration](https://developers.cloudflare.com/china-network/concepts/global-acceleration/)
- [Argo Smart Routing](https://developers.cloudflare.com/argo-smart-routing/)
- [Workers Placement](https://developers.cloudflare.com/workers/configuration/placement/)
- [D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
- [Vercel Rewrites](https://vercel.com/docs/routing/rewrites)
- [Vercel Add and configure a custom domain](https://vercel.com/docs/domains/working-with-domains/add-a-domain)
- [Vercel Limits: proxied request timeout](https://vercel.com/docs/limits#proxied-request-timeout)

## 10. 后续执行顺序

1. 保持原域名 `relay.yiheng.run` 和新加坡 Worker，不再恢复 Vercel 或静态登录壳。
2. 先持续观察真实用户的 `/api/tasks`、`/api/providers`、任务提交/轮询、R2 下载与批量下载；优先处理会重新引入跨区域往返或阻塞关键请求的问题。
3. 若大陆公网 TTFB 仍不可接受，使用自管电信/联通/移动探针验证入口 colo、DNS/TCP/TLS/TTFB，再决定是否评估 Cloudflare China Network 或香港优化线路；不要用页面样式改动替代网络治理。
4. D1 Read Replication、cursor pagination 等属于第二阶段，只在真实数据证明仍有收益时实施。
5. Cookie、Token、Provider Key 和生产用户数据不得发送到第三方公开探针。
