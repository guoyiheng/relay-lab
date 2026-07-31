#!/usr/bin/env node
/**
 * 存量数据一次性迁移：本地 .data/relay-lab.sqlite → Cloudflare D1 + R2。
 * 跑一次即弃（迁移完成后可删本脚本）。用法：
 *
 *   # 干跑（只生成 SQL 与 R2 清单，不推送，供检查）
 *   node scripts/migrate-to-cf.mjs
 *   # 真正推送到远端 D1 + R2（需先 wrangler login、建好 DB/bucket/queue、apply migrations）
 *   node scripts/migrate-to-cf.mjs --push
 *   # 推到本地 miniflare（.wrangler/state）而非远端：
 *   node scripts/migrate-to-cf.mjs --push --local
 *
 * 做三件事：
 *   1. providers/models/tasks/users/sessions/cost_entries 行 → D1（SQL 批量 INSERT）
 *   2. uploads.data BLOB → R2 uploads/{sha256}.{ext}，写 assets 行（source=local，无 data）；
 *      task_assets.upload_id → asset_id（列改名，值不变）
 *   3. tasks.result_urls 里的内联 data:base64 → R2 results/{taskId}/{idx}.{ext}，URL 改写为
 *      公开链接，并为每个结果登记一行 assets（source=generated，可复用为参考）
 *
 * R2 公开 URL 用 R2_PUBLIC_BASE（默认 https://assets.relay.yiheng.run）。
 */
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'

const PUSH = process.argv.includes('--push')
const LOCAL = process.argv.includes('--local')
const DB_PATH = process.env.DB_PATH || '.data/relay-lab.sqlite'
const R2_PUBLIC_BASE = (process.env.R2_PUBLIC_BASE || 'https://assets.relay.yiheng.run').replace(/\/+$/, '')
const BUCKET = process.env.R2_BUCKET || 'relay-lab-assets'
const D1_NAME = process.env.D1_NAME || 'relay-lab'
const TMP = '.data/_migrate_tmp'
const OUT_SQL = '.data/_migrate.sql'

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
}
const extFor = (mime, filename) => {
  if (filename && filename.includes('.')) {
    const e = filename.split('.').pop().toLowerCase()
    if (e.length >= 1 && e.length <= 5) return e
  }
  return EXT_BY_MIME[mime] || 'bin'
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const sql = (v) => {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return String(v)
  return `'${String(v).replace(/'/g, "''")}'`
}

// 历史 request/response_payload 里内联了参考图/结果图的 base64（旧 pre-R2 行为），单行可达
// 7MB，超过 D1 单行 ~1MB / 单语句 ~2MB 上限会被拒。前端本就只展示截断预览（truncateDisplay），
// 故把存储值里的大 base64 压成占位串，保留 JSON 结构不破坏 JsonTree 渲染。图片真身已在 R2
// （参考图→task_assets、结果图→result_urls 转存），此处仅瘦身历史 payload 审计记录。
function slimPayload(text) {
  if (!text) return text
  let out = text
  // ① data:<mime>;base64,xxxx URL 形态（参考图内联）
  out = out.replace(/data:([-\w.+/]+);base64,[A-Za-z0-9+/=]+/g, (_m, mime) => `data:${mime};base64,[migrated]`)
  // ② "b64_json":"xxxx" 裸 base64（provider 返回的结果图），压成短占位
  out = out.replace(/("b64_json"\s*:\s*")[A-Za-z0-9+/=]+(")/g, '$1[migrated]$2')
  return out
}

if (!existsSync(DB_PATH)) { console.error(`找不到 ${DB_PATH}`); process.exit(1) }
const db = new Database(DB_PATH, { readonly: true })
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })

const r2Puts = []      // { key, file, contentType }
const statements = []  // SQL 语句

// 收集 R2 上传 + 生成 R2 key（内容寻址）。返回公开 URL。
function stageR2(buf, mime, filename, keyHint) {
  const key = keyHint || `uploads/${sha256(buf)}.${extFor(mime, filename)}`
  const file = path.join(TMP, key.replace(/\//g, '__'))
  writeFileSync(file, buf)
  r2Puts.push({ key, file, contentType: mime || 'application/octet-stream' })
  return `${R2_PUBLIC_BASE}/${key}`
}

// ── 1. 配置表：providers / models / users / sessions / cost_entries（直接搬行）──────
function copyTable(table, cols) {
  const rows = db.prepare(`SELECT ${cols.join(',')} FROM ${table}`).all()
  for (const r of rows) {
    const vals = cols.map((c) => sql(r[c])).join(', ')
    statements.push(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${vals});`)
  }
  console.log(`  ${table}: ${rows.length} 行`)
}
console.log('准备数据：')
copyTable('providers', ['id', 'name', 'base_url', 'api_key', 'api_format', 'enabled', 'notes', 'created_at', 'updated_at'])
copyTable('models', ['id', 'provider_id', 'model_id', 'display_name', 'kind', 'default_params', 'enabled', 'price_mode', 'price_cny', 'price_in_cny', 'price_out_cny', 'price_novideo_cny', 'price_video_cny', 'polish_model', 'keys', 'created_at', 'updated_at'])

// users：老库可能无 updated_at，补 created_at 兜底
{
  const rows = db.prepare('SELECT * FROM users').all()
  for (const r of rows) {
    const cols = ['id', 'username', 'password_hash', 'avatar', 'nickname', 'created_at', 'updated_at']
    const vals = [r.id, r.username, r.password_hash, r.avatar ?? null, r.nickname ?? null, r.created_at, r.updated_at ?? r.created_at]
    statements.push(`INSERT OR REPLACE INTO users (${cols.join(', ')}) VALUES (${vals.map(sql).join(', ')});`)
  }
  console.log(`  users: ${rows.length} 行`)
}
copyTable('sessions', ['token', 'user_id', 'created_at', 'expires_at'])
copyTable('cost_entries', ['id', 'category', 'kind', 'model', 'provider', 'price_mode', 'resolution', 'duration_s', 'cost_cny', 'points', 'note', 'sort', 'created_at', 'updated_at'])

// ── 2. uploads → assets：BLOB → R2，行存 r2_key（source=local）─────────────────
{
  const rows = db.prepare('SELECT * FROM uploads').all()
  for (const r of rows) {
    const buf = r.data
    if (!buf) { console.warn(`  ⚠ upload ${r.id} 无 data，跳过`); continue }
    const sha = r.sha256 || sha256(buf)
    const key = `uploads/${sha}.${extFor(r.mime, r.filename)}`
    stageR2(buf, r.mime, r.filename, key)
    // 旧 uploads.id 保留作 assets.id（task_assets.asset_id 引用它，不必改值）。
    const cols = ['id', 'source', 'kind', 'filename', 'mime', 'size', 'width', 'height', 'sha256', 'r2_key', 'task_id', 'result_idx', 'created_at']
    const vals = [r.id, 'local', r.kind, r.filename, r.mime, r.size ?? buf.length, r.width, r.height, sha, key, null, null, r.created_at]
    statements.push(`INSERT OR REPLACE INTO assets (${cols.join(', ')}) VALUES (${vals.map(sql).join(', ')});`)
  }
  console.log(`  uploads → assets: ${rows.length} 行 → R2 + D1（source=local）`)
}

// task_assets（关联表）：旧列 upload_id → 新列 asset_id（值不变，即旧 upload id）
{
  const rows = db.prepare('SELECT task_id, kind, idx, upload_id FROM task_assets').all()
  for (const r of rows) {
    const vals = [r.task_id, r.kind, r.idx, r.upload_id]
    statements.push(`INSERT OR REPLACE INTO task_assets (task_id, kind, idx, asset_id) VALUES (${vals.map(sql).join(', ')});`)
  }
  console.log(`  task_assets: ${rows.length} 行（upload_id→asset_id）`)
}

// ── 3. tasks：内联 data:base64 结果 → R2，改写 result_urls，并登记 generated 素材 ──
{
  const rows = db.prepare('SELECT * FROM tasks').all()
  let converted = 0
  let genAssets = 0
  const guessKind = (mime) => (mime || '').startsWith('video/') ? 'video' : (mime || '').startsWith('audio/') ? 'audio' : 'image'
  // 结果对象（R2 key）→ 登记一行 generated asset，使其可被复用为参考（asset id 引用）。
  const genRow = (taskId, idx, key, mime) => {
    const id = `as_mig_${taskId}_${idx}`
    const cols = ['id', 'source', 'kind', 'filename', 'mime', 'size', 'width', 'height', 'sha256', 'r2_key', 'task_id', 'result_idx', 'created_at']
    const vals = [id, 'generated', guessKind(mime), null, mime || null, null, null, null, null, key, taskId, idx, Date.now()]
    statements.push(`INSERT OR IGNORE INTO assets (${cols.join(', ')}) VALUES (${vals.map(sql).join(', ')});`)
    genAssets++
  }
  for (const r of rows) {
    let resultUrls = r.result_urls
    if (resultUrls) {
      try {
        const arr = JSON.parse(resultUrls)
        if (Array.isArray(arr)) {
          const next = arr.map((u, i) => {
            if (typeof u !== 'string') return u
            // 内联 base64 → 转存 R2 并登记 generated 素材
            if (u.startsWith('data:')) {
              const m = u.match(/^data:([^;]+);base64,(.*)$/)
              if (!m) return u
              const mime = m[1]
              const buf = Buffer.from(m[2], 'base64')
              converted++
              const key = `results/${r.id}/${i}.${extFor(mime, null)}`
              stageR2(buf, mime, null, key)
              genRow(r.id, i, key, mime)
              return `${R2_PUBLIC_BASE}/${key}`
            }
            // 已是我方 R2 结果 URL（如之前已转存）→ 也登记 generated 素材
            const own = u.startsWith(`${R2_PUBLIC_BASE}/`) ? u.slice(R2_PUBLIC_BASE.length + 1) : null
            if (own && own.startsWith('results/')) {
              const mime = extFor(null, own) === 'mp4' ? 'video/mp4' : null
              genRow(r.id, i, own, mime)
            }
            return u
          })
          resultUrls = JSON.stringify(next)
        }
      } catch { /* 保持原样 */ }
    }
    const cols = ['id', 'provider_id', 'provider_name', 'model_id', 'model_name', 'kind', 'api_format', 'prompt', 'params', 'request_payload', 'response_payload', 'status', 'http_status', 'latency_ms', 'remote_task_id', 'result_urls', 'result_text', 'error_message', 'analysis', 'favorite', 'price_mode', 'price_cny', 'price_in_cny', 'price_out_cny', 'price_novideo_cny', 'price_video_cny', 'created_at', 'updated_at', 'finished_at', 'deleted_at']
    const vals = cols.map((c) => {
      if (c === 'result_urls') return resultUrls
      if (c === 'request_payload' || c === 'response_payload') return slimPayload(r[c] ?? null)
      return r[c] ?? null
    })
    statements.push(`INSERT OR REPLACE INTO tasks (${cols.join(', ')}) VALUES (${vals.map(sql).join(', ')});`)
  }
  console.log(`  tasks: ${rows.length} 行（${converted} 个内联结果 → R2，登记 ${genAssets} 个 generated 素材）`)
}

db.close()

// 输出 SQL 文件。D1 远端不接受显式 BEGIN TRANSACTION/COMMIT（要用 JS 事务 API），
// wrangler d1 execute 本身会把整个文件原子执行，故不再自己包事务。
// 按外键依赖重排（每个元素是一条完整语句，按 table 分桶不会切碎多行 payload）：
//   config(providers→models, users→sessions, cost_entries) → tasks → assets → task_assets
// 因 assets.task_id 与 task_assets.task_id 都引用 tasks.id，assets/task_assets 必须在 tasks 之后。
const bucketOf = (s) => {
  const m = s.match(/INTO\s+(\w+)\s/)
  return m ? m[1] : 'other'
}
const ORDER = ['providers', 'models', 'users', 'sessions', 'cost_entries', 'tasks', 'assets', 'task_assets']
const byBucket = {}
for (const s of statements) (byBucket[bucketOf(s)] ??= []).push(s)
const ordered = ORDER.flatMap((t) => byBucket[t] || [])
// 兜底：任何未列入 ORDER 的桶追加在最后，避免漏语句
for (const [t, arr] of Object.entries(byBucket)) if (!ORDER.includes(t)) ordered.push(...arr)
writeFileSync(OUT_SQL, ordered.join('\n') + '\n')
console.log(`\n生成 ${OUT_SQL}（${ordered.length} 条语句，FK 安全排序），R2 待上传 ${r2Puts.length} 个对象。`)

if (!PUSH) {
  console.log('\n[干跑] 未推送。检查无误后加 --push 执行；--local 推到本地 miniflare。')
  process.exit(0)
}

// ── 推送 R2 ──────────────────────────────────────────────────────────────────
const scope = LOCAL ? '--local' : '--remote'
console.log(`\n上传 R2（${scope}）…`)
for (const { key, file, contentType } of r2Puts) {
  execFileSync('npx', ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', contentType, scope], { stdio: 'inherit' })
}
// ── 推送 D1 ──────────────────────────────────────────────────────────────────
console.log(`\n应用 D1（${scope}）…`)
execFileSync('npx', ['wrangler', 'd1', 'execute', D1_NAME, scope, '--file', OUT_SQL], { stdio: 'inherit' })

rmSync(TMP, { recursive: true, force: true })
console.log('\n✅ 迁移完成。可删除本脚本与 .data/_migrate.sql。')
