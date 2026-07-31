/// <reference types="@cloudflare/workers-types" />
import { useDb, type ProviderRecord, type AssetKind } from './db'

// ─────────────────────────────────────────────────────────────────────────────
// Seedance 虚拟人像库（asset://）控制面 client。
// 直连 BytePlus 海外的 ark OpenAPI（Action 式 + AK/SK V4 签名），与生成用的 Bearer
// 中转是两套鉴权。流程：CreateAssetGroup → CreateAsset（拿 asset id，异步入库）→ 轮询
// GetAsset 到 Status=Active → 生成请求 content[] 里用 asset://<id> 引用。详见 pvpl.md。
// V4 签名算法照搬 yueling-server 的 SeedanceHttpUtil（火山 ark 签名，SK 不加前缀）。
// ─────────────────────────────────────────────────────────────────────────────

const ARK_SERVICE = 'ark'
const ARK_VERSION = '2024-01-01'
const DEFAULT_REGION = 'ap-southeast-1'
const DEFAULT_PROJECT = 'default'
const GROUP_TYPE = 'AIGC'
const GROUP_NAME = 'relay-lab'

// 控制面 host：ark.<region>.byteplusapi.com（海外）。
function arkHost(region: string): string {
  return `ark.${region}.byteplusapi.com`
}

// kind → BytePlus AssetType
function assetTypeOf(kind: AssetKind): string {
  return kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Image'
}

// ── Web Crypto 工具（Workers / Node 18+ 通用）────────────────────────────────
function toHex(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0')
  return s
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input
  return toHex(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource))
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const raw = key instanceof Uint8Array ? key : new Uint8Array(key)
  const k = await crypto.subtle.importKey('raw', raw as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(msg))
}

// 火山 V4 派生签名密钥：kDate=HMAC(sk, date) → kRegion → kService → kSigning。SK 不加前缀。
async function signingKey(sk: string, shortDate: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmac(new TextEncoder().encode(sk), shortDate)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, ARK_SERVICE)
  return hmac(kService, 'request')
}

// query / header 值的 URL 编码（保留 - _ . ~，空格转 %20），与 Java signStringEncoder 一致。
function encodeRfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

interface ArkCreds {
  ak: string
  sk: string
  region: string
  projectName: string
}

function resolveCreds(provider: ProviderRecord): ArkCreds | null {
  const ak = (provider.ark_access_key || '').trim()
  const sk = (provider.ark_secret_key || '').trim()
  if (!ak || !sk) return null
  return {
    ak,
    sk,
    region: (provider.ark_region || '').trim() || DEFAULT_REGION,
    projectName: (provider.ark_project_name || '').trim() || DEFAULT_PROJECT,
  }
}

const CONTROL_TIMEOUT_MS = 30 * 1000

// 一次已签名的 ark OpenAPI 调用（POST，Action/Version 走 query，body 为 JSON）。
// 返回解析后的 JSON；网络/HTTP 错误抛出（含状态码与响应体供上层透出）。
async function arkRequest(
  creds: ArkCreds,
  action: string,
  bodyObj: Record<string, unknown>,
): Promise<any> {
  const host = arkHost(creds.region)
  const bodyStr = JSON.stringify(bodyObj)
  const contentSha = await sha256Hex(bodyStr)

  const now = new Date()
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '') // yyyyMMddTHHmmssZ
  const shortDate = xDate.slice(0, 8)
  const contentType = 'application/json'

  // query 按字母序（Action, Version）
  const query = `Action=${encodeRfc3986(action)}&Version=${encodeRfc3986(ARK_VERSION)}`
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'
  const canonical = [
    'POST',
    '/',
    query,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${contentSha}`,
    `x-date:${xDate}`,
    '',
    signedHeaders,
    contentSha,
  ].join('\n')
  const canonicalHash = await sha256Hex(canonical)
  const credentialScope = `${shortDate}/${creds.region}/${ARK_SERVICE}/request`
  const stringToSign = `HMAC-SHA256\n${xDate}\n${credentialScope}\n${canonicalHash}`
  const kSigning = await signingKey(creds.sk, shortDate, creds.region)
  const signature = toHex(await hmac(kSigning, stringToSign))
  const authorization
    = `HMAC-SHA256 Credential=${creds.ak}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const url = `https://${host}/?${query}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONTROL_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Host': host,
        'X-Date': xDate,
        'X-Content-Sha256': contentSha,
        'Content-Type': contentType,
        'Authorization': authorization,
      },
      body: bodyStr,
      signal: controller.signal,
    })
    const text = await res.text()
    let json: any = null
    try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }
    return json
  } finally {
    clearTimeout(timer)
  }
}

// ark 响应统一形态：{ ResponseMetadata: { Error?: {Code,Message} }, Result: {...} }
function arkError(resp: any): { code: string; message: string } | null {
  const err = resp?.ResponseMetadata?.Error
  if (err && (err.Code || err.Message)) {
    return { code: String(err.Code || 'ArkError'), message: String(err.Message || '素材库请求失败') }
  }
  return null
}

// ── Asset API 原语 ───────────────────────────────────────────────────────────
async function createAssetGroup(creds: ArkCreds, name: string): Promise<string> {
  const resp = await arkRequest(creds, 'CreateAssetGroup', {
    Name: name,
    Description: 'Relay Lab 自动创建',
    GroupType: GROUP_TYPE,
    ProjectName: creds.projectName,
  })
  const e = arkError(resp)
  if (e) throw new Error(`创建素材组失败：${e.message}`)
  const id = resp?.Result?.Id
  if (!id) throw new Error('创建素材组后未返回 group id')
  return String(id)
}

async function listAssetGroupId(creds: ArkCreds, name: string): Promise<string | null> {
  const resp = await arkRequest(creds, 'ListAssetGroups', {
    Filter: { Name: name, GroupType: GROUP_TYPE },
    PageNumber: 1,
    PageSize: 10,
    ProjectName: creds.projectName,
  })
  if (arkError(resp)) return null
  const items = resp?.Result?.Items
  if (Array.isArray(items)) {
    const hit = items.find((it: any) => it?.Name === name) || items[0]
    if (hit?.Id) return String(hit.Id)
  }
  return null
}

async function createAsset(creds: ArkCreds, groupId: string, url: string, name: string, kind: AssetKind): Promise<string> {
  const resp = await arkRequest(creds, 'CreateAsset', {
    GroupId: groupId,
    URL: url,
    AssetType: assetTypeOf(kind),
    Name: name,
    ProjectName: creds.projectName,
  })
  const e = arkError(resp)
  if (e) throw new Error(`素材入库失败：${e.message}`)
  const id = resp?.Result?.Id
  if (!id) throw new Error('素材入库后未返回 asset id')
  return String(id)
}

// GetAsset 状态：'Active' | 'Processing' | 'Failed' | 'Missing'（查不到/报错）
async function getAssetStatus(creds: ArkCreds, assetId: string): Promise<'Active' | 'Processing' | 'Failed' | 'Missing'> {
  const resp = await arkRequest(creds, 'GetAsset', { Id: assetId, ProjectName: creds.projectName })
  if (arkError(resp)) return 'Missing'
  const status = resp?.Result?.Status
  if (status === 'Active') return 'Active'
  if (status === 'Failed') return 'Failed'
  if (status === 'Processing') return 'Processing'
  return 'Missing'
}

// ── 编排（供 taskrunner 两条路径复用）────────────────────────────────────────

// 一个待入库的参考素材：db asset 行 id（写回缓存用）、public_url（content[] 里出现的原始 URL）、kind。
export interface RefItem {
  assetDbId: string
  public_url: string
  kind: AssetKind
}

export function providerHasArkCreds(provider: ProviderRecord): boolean {
  return !!resolveCreds(provider)
}

// 确保该平台有可用的 AIGC 素材组 id：优先用缓存列，否则 List 命中复用 / Create 新建，回写 providers 行。
export async function ensureAssetGroupId(provider: ProviderRecord): Promise<string> {
  const creds = resolveCreds(provider)
  if (!creds) throw new Error('该平台未配置素材库 AK/SK')
  const cached = (provider.ark_asset_group_id || '').trim()
  if (cached) return cached
  let groupId = await listAssetGroupId(creds, GROUP_NAME)
  if (!groupId) groupId = await createAssetGroup(creds, GROUP_NAME)
  try {
    await useDb().prepare('UPDATE providers SET ark_asset_group_id = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(groupId, Date.now(), provider.id, provider.user_id)
  } catch { /* 缓存失败不影响本次使用 */ }
  return groupId
}

// 对每个参考素材确保有 asset id（幂等）：命中 assets.seedance_asset_id 缓存则直接用；
// 否则 CreateAsset 拿 id 并写回缓存。不等待 Active。返回 public_url → assetId 映射 + 全部 assetId 列表。
export async function ensureAssetIds(
  provider: ProviderRecord,
  groupId: string,
  items: RefItem[],
): Promise<{ urlToAssetId: Map<string, string>; assetIds: string[] }> {
  const creds = resolveCreds(provider)
  if (!creds) throw new Error('该平台未配置素材库 AK/SK')
  const db = useDb()
  const urlToAssetId = new Map<string, string>()
  const assetIds: string[] = []

  // 读一次现有缓存
  const cacheById = new Map<string, string | null>()
  const uniqueDbIds = Array.from(new Set(items.map((i) => i.assetDbId)))
  if (uniqueDbIds.length) {
    const ph = uniqueDbIds.map(() => '?').join(',')
    const rows = await db.prepare(`SELECT id, seedance_asset_id FROM assets WHERE user_id = ? AND id IN (${ph})`)
      .all(provider.user_id, ...uniqueDbIds) as { id: string; seedance_asset_id: string | null }[]
    for (const r of rows) cacheById.set(r.id, r.seedance_asset_id)
  }

  for (const item of items) {
    let assetId = (cacheById.get(item.assetDbId) || '').trim()
    if (!assetId) {
      assetId = await createAsset(creds, groupId, item.public_url, item.assetDbId, item.kind)
      try {
        await db.prepare('UPDATE assets SET seedance_asset_id = ? WHERE id = ? AND user_id = ?').run(assetId, item.assetDbId, provider.user_id)
      } catch { /* 缓存写失败不影响本次 */ }
      cacheById.set(item.assetDbId, assetId)
    }
    urlToAssetId.set(item.public_url, assetId)
    assetIds.push(assetId)
  }
  return { urlToAssetId, assetIds }
}

// 检查一批 asset 是否全部 Active。Failed 的清掉对应 assets 缓存（下次重新入库）并汇报。
export async function checkAssetsActive(
  provider: ProviderRecord,
  assetIds: string[],
): Promise<{ allActive: boolean; failed: string[] }> {
  const creds = resolveCreds(provider)
  if (!creds) throw new Error('该平台未配置素材库 AK/SK')
  const failed: string[] = []
  let allActive = true
  for (const id of assetIds) {
    const status = await getAssetStatus(creds, id)
    if (status === 'Failed' || status === 'Missing') {
      failed.push(id)
      allActive = false
      try {
        await useDb().prepare('UPDATE assets SET seedance_asset_id = NULL WHERE seedance_asset_id = ? AND user_id = ?').run(id, provider.user_id)
      } catch { /* ignore */ }
    } else if (status !== 'Active') {
      allActive = false
    }
  }
  return { allActive, failed }
}

const ACTIVE_POLL_GAP_MS = 2000
const ACTIVE_MAX_MS = 3 * 60 * 1000

// 进程内路径（dev / 无队列）：一把做完 —— 建组 + 入库 + 轮询到全部 Active。
// 返回 public_url → assetId 映射；任一 Failed 或超时抛错（错误信息透给任务）。
export async function ingestRefsBlocking(
  provider: ProviderRecord,
  items: RefItem[],
): Promise<Map<string, string>> {
  const groupId = await ensureAssetGroupId(provider)
  const { urlToAssetId, assetIds } = await ensureAssetIds(provider, groupId, items)
  const startedAt = Date.now()
  while (true) {
    const { allActive, failed } = await checkAssetsActive(provider, assetIds)
    if (failed.length) throw new Error('参考素材入库审核未通过（可能含真人/违规内容），已拦截')
    if (allActive) break
    if (Date.now() - startedAt > ACTIVE_MAX_MS) throw new Error('参考素材入库超时（预处理未在限定时间内完成）')
    await new Promise((r) => setTimeout(r, ACTIVE_POLL_GAP_MS))
  }
  return urlToAssetId
}
