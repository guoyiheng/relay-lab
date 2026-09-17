// 参考素材上传的通用方法（抽离自 pages/index.vue 的提交逻辑）。
// 约定：素材一律「先上传到 R2 拿到 asset id，再用 id 发起任务」，全程不走 base64。
//   · 已有 asset id（本地已传 / 生成素材直接引用）→ 原样返回，零网络
//   · pending 本地文件（File）→ POST /api/uploads（multipart），服务端 sha256 去重
//   · pending 远端 URL（拖入的生成结果等）→ POST /api/uploads/import，
//     若是我方 R2 对象则秒级复用其 asset 行，不重新下载
// 返回真实 asset id 列表，顺序与入参一致；单个失败跳过而非整体中断。

export interface RefUploadItem {
  id: string                // asset id；'' 表示尚未落库（pending）
  kind: 'image' | 'video' | 'audio'
  public_url?: string       // pending 远端 URL 导入用
  file?: File               // pending 本地文件上传用
}

export interface AnyRefItem {
  id?: string | null
  sig?: string | null
  public_url?: string | null
  url?: string | null
  file?: File | null
  source?: string | null
}

/** 提取素材/引用的所有标识 token（用于跨状态去重及引用关联） */
export function getRefTokens(item: AnyRefItem | null | undefined): string[] {
  if (!item) return []
  const tokens = new Set<string>()

  const rawSig = item.sig?.trim()
  if (rawSig) {
    tokens.add(rawSig)
    if (rawSig.startsWith('id:')) tokens.add(rawSig.slice(3))
    if (rawSig.startsWith('url:')) tokens.add(rawSig.slice(4))
  }

  const rawId = item.id?.trim()
  if (rawId) {
    tokens.add(rawId)
    if (rawId.startsWith('id:')) {
      tokens.add(rawId.slice(3))
    } else if (!rawId.startsWith('file:') && !rawId.startsWith('url:') && !rawId.startsWith('blob:')) {
      tokens.add(`id:${rawId}`)
    } else if (rawId.startsWith('url:')) {
      tokens.add(rawId.slice(4))
    }
  }

  const rawUrl = (item.public_url || item.url)?.trim()
  if (rawUrl) {
    tokens.add(rawUrl)
    tokens.add(`url:${rawUrl.replace(/^url:/, '')}`)
    const m = rawUrl.match(/\/uploads\/([^/?#]+)/)
    if (m && m[1]) {
      tokens.add(m[1])
      tokens.add(`id:${m[1]}`)
    }
  }

  if (item.file) {
    tokens.add(`file:${item.file.name}|${item.file.size}|${item.file.lastModified}`)
  }

  return Array.from(tokens)
}

/** 生成统一的规范签名（优先已有 sig，其次真实 id，再次 url/file） */
export function canonicalRefSig(item: AnyRefItem | null | undefined): string {
  if (!item) return ''
  if (item.sig?.trim()) return item.sig.trim()
  const rawId = item.id?.trim()
  if (rawId) {
    if (rawId.startsWith('id:') || rawId.startsWith('file:') || rawId.startsWith('url:')) return rawId
    return `id:${rawId}`
  }
  const rawUrl = (item.public_url || item.url)?.trim()
  if (rawUrl) {
    return rawUrl.startsWith('url:') ? rawUrl : `url:${rawUrl}`
  }
  if (item.file) {
    return `file:${item.file.name}|${item.file.size}|${item.file.lastModified}`
  }
  return ''
}

/** 判断两个素材引用是否为同一个资源（防重复添加） */
export function isSameRef(a: AnyRefItem | null | undefined, b: AnyRefItem | null | undefined): boolean {
  if (!a || !b) return false

  // 1. 直连 URL / blob URL 完全一致
  const urlA = (a.public_url || a.url)?.trim()
  const urlB = (b.public_url || b.url)?.trim()
  if (urlA && urlB && urlA === urlB) return true

  // 2. 真实数据库 asset id 一致（排除 file:、url: 等前缀伪 id）
  const idA = a.id?.replace(/^id:/, '').trim()
  const idB = b.id?.replace(/^id:/, '').trim()
  if (idA && idB && idA === idB && !idA.startsWith('file:') && !idA.startsWith('url:') && !idA.startsWith('task:')) return true

  // 3. 显式签名完全一致
  const sigA = a.sig?.trim()
  const sigB = b.sig?.trim()
  if (sigA && sigB && sigA === sigB) return true

  // 4. Token 交集匹配（跨 url/id/sig 格式）
  const tokensA = getRefTokens(a)
  const tokensB = new Set(getRefTokens(b))
  return tokensA.some((t) => tokensB.has(t))
}

/** 把一批参考素材解析成 asset id 数组（在任务提交前调用）。委托给 DataSource（离线/在线一致）。 */
export function uploadRefsToAssetIds(items: RefUploadItem[]): Promise<string[]> {
  return useDataSource().resolveRefIds(items)
}
