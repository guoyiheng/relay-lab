import { isIP } from 'node:net'

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number)
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true
  const a = octets[0]!
  const b = octets[1]!
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224
}

export function isPrivateNetworkTarget(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.lan')
    || host.endsWith('.home.arpa')
  ) return true

  const ipVersion = isIP(host)
  if (!ipVersion) return false
  if (ipVersion === 4) return isPrivateIpv4(host)

  if (host === '::1' || host === '::') return true
  if (host.startsWith('fc') || host.startsWith('fd')) return true
  if (/^fe[89ab]/.test(host)) return true
  const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped?.[1] ? isPrivateIpv4(mapped[1]) : false
}

export function parsePublicHttpUrl(raw: string): URL {
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    throw createError({ statusCode: 400, statusMessage: '无效 URL' })
  }
  if (
    !['http:', 'https:'].includes(target.protocol)
    || target.username
    || target.password
    || isPrivateNetworkTarget(target.hostname)
  ) {
    throw createError({ statusCode: 400, statusMessage: '无效 URL' })
  }
  return target
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw createError({ statusCode: 413, statusMessage: `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限` })
  }
  if (!response.body) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('response too large')
        throw createError({ statusCode: 413, statusMessage: `文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限` })
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
