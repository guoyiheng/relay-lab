/// <reference types="@cloudflare/workers-types" />
import crypto from 'node:crypto'

// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare 数据层。原 better-sqlite3 单文件已迁到 D1（异步）+ R2（二进制）。
//   · schema/迁移：见 migrations/*.sql（wrangler d1 migrations），不再运行时建表
//   · 存量数据：一次性迁移脚本导入，故此处无种子/无孤儿回收
//   · binding 来源：globalThis.__env__。
//       - 生产 Worker：_module-handler 在 fetch/queue/scheduled 各入口设置。
//       - 本地 dev：Nitro cloudflare 预设的 plugin.dev 在 getPlatformProxy 成功后设置，
//         直连线上 D1/R2（wrangler.jsonc 的 binding 上 remote:true）。需 wrangler 认证：
//         CLOUDFLARE_API_TOKEN（+ ACCOUNT_ID）或 wrangler login。
// ─────────────────────────────────────────────────────────────────────────────

export interface CloudflareEnv {
  DB: D1Database
  BUCKET: R2Bucket
  TASK_QUEUE?: Queue
  R2_PUBLIC_BASE?: string
  RESEND_API_KEY?: string
  RESEND_FROM?: string
  REGISTRATION_INVITE_CODE?: string
  AUTH_IP_HASH_SECRET?: string
  SESSION_CACHE_SECRET?: string
  CF_VERSION_METADATA?: WorkerVersionMetadata
  PUBLIC_APP_URL?: string
  OFFLINE_PROXY_ALLOW_HTTP?: string
  OFFLINE_PROXY_HEAVY_RATE_LIMITER?: RateLimit
  OFFLINE_PROXY_POLL_RATE_LIMITER?: RateLimit
  OFFLINE_PROXY_FETCH_RATE_LIMITER?: RateLimit
  AUTH_LOGIN_RATE_LIMITER?: RateLimit
  AUTH_PUBLIC_RATE_LIMITER?: RateLimit
  OFFLINE_PROXY_HEAVY_GLOBAL_RATE_LIMITER?: RateLimit
  OFFLINE_PROXY_POLL_GLOBAL_RATE_LIMITER?: RateLimit
  OFFLINE_PROXY_FETCH_GLOBAL_RATE_LIMITER?: RateLimit
  AUTH_PUBLIC_GLOBAL_RATE_LIMITER?: RateLimit
  [key: string]: unknown
}

export function cfEnv(): CloudflareEnv {
  const env = (globalThis as any).__env__ as CloudflareEnv | undefined
  if (env?.DB) return env
  throw new Error('Cloudflare binding 不可用：globalThis.__env__ 未就绪。dev 下确认 wrangler 已认证（CLOUDFLARE_API_TOKEN 或 wrangler login），且 nuxt.config compatibilityDate >= 2025-07-15。')
}

// ── better-sqlite3 兼容 shim ────────────────────────────────────────────────
// 保留 .prepare().get/all/run 的调用形态，仅由同步转异步（调用点加 await）：
//   .get(...args)  → D1 .first()（无则 null）
//   .all(...args)  → D1 .all().results
//   .run(...args)  → { changes, lastInsertRowid }（映射 meta.last_row_id）
// 交互式事务无对应物：静态多语句用 db.batch()，动态判断改写为 SQL 反连接。

export interface RunResult { changes: number; lastInsertRowid: number }

class Stmt {
  constructor(private readonly d1: D1Database, private readonly sql: string) {}
  private bound(args: unknown[]): D1PreparedStatement {
    const s = this.d1.prepare(this.sql)
    return args.length ? s.bind(...args) : s
  }
  get<T = any>(...args: unknown[]): Promise<T | null> {
    return this.bound(args).first<T>() as Promise<T | null>
  }
  async all<T = any>(...args: unknown[]): Promise<T[]> {
    const r = await this.bound(args).all<T>()
    return r.results as T[]
  }
  async run(...args: unknown[]): Promise<RunResult> {
    const r = await this.bound(args).run()
    return { changes: r.meta.changes ?? 0, lastInsertRowid: Number(r.meta.last_row_id ?? 0) }
  }
}

export interface Db {
  prepare(sql: string): Stmt
  batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>
  exec(sql: string): Promise<D1ExecResult>
  /** 原始 D1 句柄：用于 batch / RETURNING 等 shim 未覆盖的场景 */
  readonly d1: D1Database
}

export function useDb(): Db {
  const d1 = cfEnv().DB
  return {
    d1,
    prepare: (sql: string) => new Stmt(d1, sql),
    batch: (stmts: D1PreparedStatement[]) => d1.batch(stmts),
    exec: (sql: string) => d1.exec(sql),
  }
}

export function useBucket(): R2Bucket {
  return cfEnv().BUCKET
}

// 任务队列 producer。绑定缺失（未付费）时返回 null，调用方回退到进程内轮询。
// 本地 nuxt dev 例外：getPlatformProxy 会暴露 producer binding（非空），但 dev 不
// 运行 cloudflare:queue 消费者——发出的消息无人消费，异步任务会永远卡 running。
// 故 dev 下强制返回 null，让 startTask 走进程内轮询（Node 进程可长活，符合设计）。
export function useQueue(): Queue | null {
  if (import.meta.dev) return null
  try {
    return cfEnv().TASK_QUEUE ?? null
  } catch {
    return null
  }
}

// ── 密码哈希（node:crypto，nodejs_compat 下 scrypt/timingSafeEqual 均支持）──────
export function hashPassword(password: string, salt?: string) {
  const s = salt || crypto.randomBytes(16).toString('hex')
  const buf = crypto.scryptSync(password, s, 64)
  return `${s}:${buf.toString('hex')}`
}

export function verifyPassword(password: string, stored: string) {
  const [salt, hex] = stored.split(':')
  if (!salt || !hex) return false
  const buf = crypto.scryptSync(password, salt, 64)
  const a = Buffer.from(hex, 'hex')
  if (a.length !== buf.length) return false
  return crypto.timingSafeEqual(a, buf)
}

// ── 类型 ──────────────────────────────────────────────────────────────────────
export type ApiFormat = 'openai-sync' | 'openai-async' | 'xai-image' | 'doubao-video'
export type ModelKind = 'image' | 'video' | 'text'
export type PriceMode = 'per_call' | 'per_mtoken' | 'per_mtoken_video'
export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed'
export type AssetKind = 'image' | 'video' | 'audio'
export type AssetSource = 'local' | 'generated'

export interface CostEntryRecord {
  id: number
  category: string
  kind: 'image' | 'video'
  model: string
  provider: string | null
  price_mode: string | null
  resolution: string | null
  duration_s: number | null
  cost_cny: number
  points: number | null
  note: string | null
  sort: number
  created_at: number
  updated_at: number
}

export interface ProviderRecord {
  id: number
  user_id: number
  name: string
  base_url: string
  api_key: string
  api_format: ApiFormat
  enabled: number
  notes: string | null
  // Seedance 素材库控制面（AK/SK 直连 BytePlus 海外，仅 doubao-video 平台用）。见 migrations/0002。
  ark_access_key: string | null
  ark_secret_key: string | null
  ark_region: string | null
  ark_project_name: string | null
  ark_asset_group_id: string | null
  created_at: number
  updated_at: number
}

export interface ModelRecord {
  id: number
  user_id: number
  provider_id: number
  model_id: string
  display_name: string | null
  kind: ModelKind
  default_params: string | null
  enabled: number
  price_mode: PriceMode | null
  price_cny: number | null
  price_in_cny: number | null
  price_out_cny: number | null
  price_novideo_cny: number | null
  price_video_cny: number | null
  polish_model: number
  keys: string | null
  created_at: number
  updated_at: number
}

export interface TaskRecord {
  id: number
  user_id: number
  provider_id: number | null
  provider_name: string
  model_id: number | null
  model_name: string
  kind: ModelKind
  api_format: ApiFormat
  prompt: string
  params: string | null
  request_payload: string | null
  response_payload: string | null
  status: TaskStatus
  http_status: number | null
  latency_ms: number | null
  remote_task_id: string | null
  result_urls: string | null
  result_text: string | null
  error_message: string | null
  analysis: string | null
  favorite: number
  price_mode: PriceMode | null
  price_cny: number | null
  price_in_cny: number | null
  price_out_cny: number | null
  price_novideo_cny: number | null
  price_video_cny: number | null
  created_at: number
  updated_at: number
  finished_at: number | null
  deleted_at: number | null
  assets_expires_at: number | null
  assets_cleaned_at: number | null
  assets_cleanup_reason: string | null
}

export interface UserRecord {
  id: number
  username: string
  email: string | null
  email_verified_at: number | null
  storage_namespace: string
  password_hash: string
  avatar: string | null
  nickname: string | null
  created_at: number
  updated_at: number | null
}

export interface SessionRecord {
  token: string
  user_id: number
  created_at: number
  expires_at: number
}

// 本地上传 + 生成结果统一表。字节存 R2，D1 存元数据 + r2_key。
// source='generated' 时 task_id/result_idx 指向来源任务的第 idx 个结果。
export interface AssetRecord {
  id: string
  user_id: number
  source: AssetSource
  kind: AssetKind
  filename: string | null
  mime: string | null
  size: number | null
  width: number | null
  height: number | null
  sha256: string | null
  r2_key: string
  task_id: number | null
  result_idx: number | null
  // 缓存该素材在 Seedance 虚拟人像库的 asset id（asset://<id>），避免重复上传。见 migrations/0002。
  seedance_asset_id: string | null
  expires_at: number | null
  created_at: number
}
/** @deprecated 旧名，等价 AssetRecord（uploads 已并入 assets 表）。 */
export type UploadRecord = AssetRecord

export interface TaskAssetRow {
  task_id: number
  user_id: number
  kind: AssetKind
  idx: number
  asset_id: string
}
