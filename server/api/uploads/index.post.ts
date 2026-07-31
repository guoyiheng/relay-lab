import { readMultipartFormData } from 'h3'
import { type AssetKind } from '~~/server/utils/db'
import { putAssetFromBytes } from '~~/server/utils/assets'
import { requireUserStorageNamespace } from '~~/server/utils/auth'

const KIND_MIME_PREFIX: Record<AssetKind, string> = {
  image: 'image/',
  video: 'video/',
  audio: 'audio/',
}

const MAX_BYTES: Record<AssetKind, number> = {
  image: 30 * 1024 * 1024,
  video: 100 * 1024 * 1024,
  audio: 30 * 1024 * 1024,
}

const ALLOWED_EXT: Record<AssetKind, string[]> = {
  image: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
  video: ['.mp4', '.mov', '.webm'],
  audio: ['.mp3', '.wav', '.m4a', '.aac', '.ogg'],
}

function extOf(filename: string | undefined): string {
  if (!filename) return ''
  const i = filename.lastIndexOf('.')
  return i >= 0 ? filename.slice(i).toLowerCase() : ''
}

// Best-effort dimension extraction by parsing PNG/JPEG/GIF/WEBP magic-number
// headers. Returns null when the format isn't recognised — that's fine, the
// width/height columns are nullable in the schema.
function readImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null
  // PNG: 8-byte signature + 4-byte length + "IHDR" + width(4) + height(4)
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  }
  // GIF87a / GIF89a: width/height are little-endian uint16 at offsets 6, 8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  }
  // JPEG: scan SOF markers (0xFFC0..0xFFCF, except 4, 8, 12)
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue }
      const marker = buf.readUInt8(i + 1)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
      }
      const segLen = buf.readUInt16BE(i + 2)
      i += 2 + segLen
    }
    return null
  }
  // WEBP: "RIFF"...."WEBP" then chunk types VP8/VP8L/VP8X
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
    const chunk = buf.slice(12, 16).toString('ascii')
    if (chunk === 'VP8X' && buf.length >= 30) {
      // 24-bit little-endian width-1/height-1 at offset 24/27
      const w = buf.readUIntLE(24, 3) + 1
      const h = buf.readUIntLE(27, 3) + 1
      return { width: w, height: h }
    }
    if (chunk === 'VP8 ' && buf.length >= 30) {
      // VP8 bitstream: width/height at +26 +28 (14 bits each, low-endian)
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    }
    if (chunk === 'VP8L' && buf.length >= 25) {
      const b1 = buf.readUInt8(21), b2 = buf.readUInt8(22), b3 = buf.readUInt8(23), b4 = buf.readUInt8(24)
      return { width: ((b1 | (b2 << 8)) & 0x3fff) + 1, height: (((b2 >> 6) | (b3 << 2) | ((b4 & 0x0f) << 10))) + 1 }
    }
  }
  return null
}

export default defineEventHandler(async (event) => {
  const { userId, storageNamespace } = await requireUserStorageNamespace(event)
  const form = await readMultipartFormData(event)
  if (!form?.length) throw createError({ statusCode: 400, statusMessage: '未收到文件' })

  const filePart = form.find((p) => p.name === 'file' && p.filename)
  const kindPart = form.find((p) => p.name === 'kind')
  if (!filePart) throw createError({ statusCode: 400, statusMessage: '缺少 file 字段' })

  const kind = (kindPart?.data?.toString() || '').trim() as AssetKind
  if (!KIND_MIME_PREFIX[kind]) {
    throw createError({ statusCode: 400, statusMessage: 'kind 必须是 image / video / audio' })
  }
  if (filePart.data.length > MAX_BYTES[kind]) {
    throw createError({
      statusCode: 413,
      statusMessage: `${kind} 文件超过 ${MAX_BYTES[kind] / 1024 / 1024}MB 上限`,
    })
  }
  const ext = extOf(filePart.filename)
  if (ext && !ALLOWED_EXT[kind].includes(ext)) {
    throw createError({
      statusCode: 400,
      statusMessage: `不支持的 ${kind} 格式：${ext}`,
    })
  }

  const dims = kind === 'image' ? readImageDimensions(filePart.data) : null
  const bytes = new Uint8Array(filePart.data)
  // 统一走 assets 写入入口：sha256 去重、字节落 R2、D1 存元数据行（source=local）。
  const asset = await putAssetFromBytes({
    userId, storageNamespace,
    bytes,
    kind,
    mime: filePart.type || null,
    filename: filePart.filename || null,
    width: dims?.width ?? null,
    height: dims?.height ?? null,
    source: 'local',
  })

  return {
    id: asset.id,
    kind: asset.kind,
    filename: asset.filename,
    mime: asset.mime,
    size: asset.size,
    width: asset.width,
    height: asset.height,
    public_url: asset.public_url,
    deduped: asset.deduped,
  }
})
