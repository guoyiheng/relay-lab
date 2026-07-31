# 敏感词分析、结构化分析 与 收藏（Favorites）产品文档

> 目标：将项目中「敏感词分析」「结构化分析」「收藏功能」抽象成可复用的产品规范与实现建议，便于在其他项目或模块中复用。

---

## 1 概述

- 敏感词分析：对用户输入的提示词（prompt）或生成文本进行安全扫描，标注潜在敏感项并给出替代表述建议（可选）。
- 结构化分析：把原始的自由文本提示词分析成结构化的提示词片段（主体/动作/风格/细节等），便于不同模型或不同生成类型（图/视频/文本）消费与展示。
- 收藏（Favorites）：用户可以收藏/管理常用提示词或分析结果，前端提供快速调用与回填功能。

设计原则：轻量、异步可恢复、可审计（结果可追溯）、权限控制与隐私保护。

---

## 2 高层流程（统一）

1. 前端用户在创作区提交「分析」或点击「收藏」：调用后端 API 创建分析任务或收藏项。
2. 后端入库（`analysis_jobs` / `favorites`），立即返回任务 id/收藏 id，前端展示 loading/轮询界面。
3. 分析逻辑：调用大语言模型（或内部规则引擎）执行分析；分析可以是同步（快速文本）或异步（较重的结构化分析/敏感词批量扫描）。
4. 分析完成后写回数据库，更新任务状态与结果；前端轮询或 websocket 推送更新并渲染结果。

注意：分析为异步时，必须保证刷新不丢失状态（以 DB 为单一事实源）。

---

## 3 数据库设计建议

- `analysis_jobs`（存储结构化分析与敏感词分析任务）
  - `id` TEXT/UUID
  - `task_id` TEXT NULL — 可选，若分析和某个创作任务关联
  - `user_id` TEXT
  - `type` ENUM('structure','sensitive')
  - `status` ENUM('pending','running','succeeded','failed')
  - `input` JSON — 原始输入（可截断或脱敏）
  - `result` JSON NULL — 分析结果结构
  - `model` TEXT NULL — 使用的大语言模型快照
  - `cost_cny` NUMERIC NULL — 可选计价信息
  - `created_at` TIMESTAMP
  - `updated_at` TIMESTAMP

- `favorites`（用户收藏）
  - `id` TEXT/UUID
  - `user_id` TEXT
  - `title` TEXT
  - `kind` ENUM('prompt','analysis','snippet')
  - `content` TEXT/JSON — 收藏内容（纯文本或结构化）
  - `meta` JSON NULL — 标签、原始来源 task_id 等
  - `created_at` TIMESTAMP
  - `updated_at` TIMESTAMP

索引建议：按 `user_id`、`type`、`created_at` 建索引以加速历史/筛选。

数据保留与隐私：原始敏感内容不要无限期保留；长文本可只保留摘要或哈希并在 DB 中标注脱敏状态。

---

## 4 API 设计（建议）

说明：所有 API 均需鉴权并基于当前用户 `user_id` 操作。

- POST `/api/analysis` — 创建分析任务
  - body: { type: 'structure'|'sensitive', input: string, task_id?: string, options?: { model?: string } }
  - response: { id, status:'pending' }

- GET `/api/analysis/{id}` — 查询分析任务
  - response: { id, status, result?, error? }

- POST `/api/favorites` — 新增收藏
  - body: { title, kind, content, meta? }
  - response: { id }

- GET `/api/favorites` — 列表（支持分页、按 tag/keyword 过滤）

- DELETE `/api/favorites/{id}` — 删除收藏（软删/真删按产品策略）

前端行为：创建分析后立即在 UI 中写入初始占位结果（例如状态/时间/task link），并开始轮询 `/api/analysis/{id}` 或订阅 websocket 更新。

示例分析请求：

```json
{
  "type":"structure",
  "input":"一位穿红色连衣裙的女性在日落的海边，摄影风格柔和，广角镜头",
  "options":{ "model":"gpt-5.5" }
}
```

示例分析结果（结构化）：

```json
{
  "subject":"女性",
  "attributes":["红色连衣裙","日落","海边"],
  "style":["柔和"],
  "camera":["广角"],
  "highlights":["红色连衣裙与日落光线形成对比"],
  "suggested_prompt":"拍摄一位穿红色连衣裙的女性在海边日落时的广角柔和光摄影，强调裙摆与余晖交织",
  "warnings":[]
}
```

示例敏感词分析结果：

```json
{
  "issues": [
    { "span":"血腥描述","category":"violence","severity":"high","suggestion":"用‘深红色液体’替代具体血腥描写" }
  ]
}
```

---

## 5 后端实现要点（工程级）

- 抽离公共执行器：`runAnalysisJob(job)`，根据 `job.type` 调度 `runStructureAnalysis` 或 `runSensitiveAnalysis`。
- 支持同步/异步模式：
  - 简短任务可直接同步执行并返回（低延迟体验）。
  - 较长或耗费模型令牌的任务走后台队列（如 Cloudflare Queues / D1 + durable workers），并把中间 `response_payload` 写回 DB，前端按 task id 展示轮询。
- 错误与重试策略：对瞬时网络/模型错误重试（指数退避，最多 3 次）；对明确的输入错误或模型拒绝立即返回失败。
- 成本计量：若需要显示成本，在 `analysis_jobs` 中记录 `cost_cny` 和 `model` 快照。

实现细节建议参考仓库的现有结构：
- 请求构建与落库：与 `server/api/tasks/run.post.ts` 的做法一致，创建记录后立刻返回。
- 轮询与超时策略：复用 `server/utils/adapters.ts` 中 `pollUntilTerminal` 的思路（统一超时、单次请求超时与重试策略）。

---

## 6 前端 UX & 交互细节

- 按钮与入口：在结果区增加 `结构化分析`、`敏感词分析`、`收藏` 三个操作按钮；使用 Carbon 图标并保持点击反馈动画。
- Loading & Skeleton：创建任务后显示骨架或局部 loading，避免整页阻塞。
- 显示粒度：结构化分析在左侧以列式展示（主体/动作/风格），右侧显示建议 prompt；敏感词在文本中高亮并提供替换建议。
- 收藏用例：在提示词或分析结果旁提供 `收藏` 按钮，收藏后可从 `/favorites` 面板快速检索并回填到创作区。
- 回填与复用：收藏或分析结果应支持一键回填到创作表单（保持字段对齐），同时支持“回填并运行”快捷操作。

可复用组件建议：
- `AnalysisResultViewer`：通用的分析结果展示组件（支持 `structure` 与 `sensitive` 两种渲染模式）。
- `FavoritesPanel`：分页的收藏列表，支持标签筛选、全文搜索与拖拽回填。

---

## 7 权限、审计与合规

- 所有分析/收藏操作要记录 `user_id` 与 `created_at`，便于审计。
- 敏感词发现后若需自动替换或屏蔽，应由产品配置决定，并在 UI 明示（不自动篡改用户原文，除非显式选择替换）。
- 隐私：采集的提示词若包含 PII（个人信息）应按合规策略脱敏或只保留哈希。

---

## 8 可选扩展与集成点

- 支持多模型（例如 GPT-5.5 / gpt-image-2）做比对并合并结果。
- 增加“批量分析”接口，供历史任务批量回溯分析。
- 将收藏同步到浏览器 `localStorage` 作跨页面快速缓存（并在服务器保存持久副本）。

---

## 9 迁移与兼容（给开发者的提示）

- 若将该功能复用到其他仓库：
  - 复制 `analysis_jobs` 与 `favorites` 表结构；
  - 复用 `runAnalysisJob` 执行器（或封装为微服务）；
  - 前端提供统一的 `AnalysisResultViewer` 组件。

---

## 10 快速开始（示例集成）

1) 创建结构化分析任务：

POST /api/analysis

body: { type: 'structure', input: '你的提示词' }

等待 `/api/analysis/{id}` 返回 `succeeded`，拿 `result.suggested_prompt` 回填创作区。

2) 收藏提示词：

POST /api/favorites { title:'日落人像', kind:'prompt', content:'...' }

然后在 `FavoritesPanel` 列表中选择回填。

---

如果你希望我把这份文档合并到现有的 [CLAUDE.md](CLAUDE.md) 或者生成一个更精简的用户版本（product one-pager），告诉我要合并到哪个文件，我可以继续修改并提交补丁。
