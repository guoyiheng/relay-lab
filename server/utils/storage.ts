/// <reference types="@cloudflare/workers-types" />
import crypto from 'node:crypto'
import { cfEnv, useBucket } from './db'

// ─────────────────────────────────────────────────────────────────────────────
// R2 二进制存储。参考素材与生成结果的字节都落 R2，D1 只存 key + 元数据。
//   key 约定：
//     users/{namespace}/uploads/{assetId}.{ext}       用户参考素材
//     users/{namespace}/results/{taskId}/{idx}.{ext}  用户生成结果
//   namespace 为每个用户随机生成的 128-bit 值，避免公开 R2 URL 被顺序枚举。
//   对外 URL：直连公开域 R2_PUBLIC_BASE（assets.relay.yiheng.run，配在 wrangler.jsonc vars）。
// ─────────────────────────────────────────────────────────────────────────────

export function sha256Hex(data: Uint8Array | ArrayBuffer): string {
  const buf = Buffer.from(data as any)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a',
}

export function extFor(mime?: string | null, filename?: string | null): string {
  if (filename && filename.includes('.')) {
    const e = filename.split('.').pop()!.toLowerCase()
    if (e.length >= 1 && e.length <= 5) return e
  }
  if (mime && EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  return 'bin'
}

export function uploadKey(namespace: string, assetId: string, ext: string): string {
  return `users/${namespace}/uploads/${assetId}.${ext}`
}

export function resultKey(namespace: string, taskId: number, idx: number, ext: string): string {
  return `users/${namespace}/results/${taskId}/${idx}.${ext}`
}

/** 对外可访问 URL：直连 R2 公开域 R2_PUBLIC_BASE。 */
export function r2PublicUrl(key: string): string {
  const base = String(cfEnv().R2_PUBLIC_BASE ?? '').replace(/\/+$/, '')
  return `${base}/${key.replace(/^\/+/, '')}`
}

/** r2PublicUrl 的逆：从我方公开域 URL 反解出 R2 key（用于删除结果对象）。非我方 URL 返回 null。 */
export function keyFromUrl(url: string): string | null {
  if (!url) return null
  const base = String(cfEnv().R2_PUBLIC_BASE ?? '').replace(/\/+$/, '')
  const prefix = `${base}/`
  if (base && url.startsWith(prefix)) return url.slice(prefix.length)
  return null
}

export async function putObject(
  key: string,
  data: Uint8Array | ArrayBuffer | ReadableStream,
  opts: { contentType?: string | null } = {},
): Promise<string> {
  await useBucket().put(key, data as any, {
    httpMetadata: {
      contentType: opts.contentType || 'application/octet-stream',
      // 内容寻址（sha256/固定 key），可长缓存
      cacheControl: 'public, max-age=31536000, immutable',
    },
  })
  return key
}

export function getObject(key: string): Promise<R2ObjectBody | null> {
  return useBucket().get(key) as Promise<R2ObjectBody | null>
}
