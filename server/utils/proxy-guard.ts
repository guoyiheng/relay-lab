import { cfEnv } from './db'
import { parsePublicHttpUrl } from './remote-fetch'

/** 校验并返回规范化的公网 URL。携带 API Key 的上游生产环境默认只允许 HTTPS。 */
export function assertSafeUpstreamUrl(raw: string, options: { allowHttp?: boolean } = {}): string {
  const target = parsePublicHttpUrl(raw)
  const configuredHttp = String(cfEnv().OFFLINE_PROXY_ALLOW_HTTP || '') === '1'
  if (target.protocol !== 'https:' && !options.allowHttp && !configuredHttp && !import.meta.dev) {
    throw createError({ statusCode: 400, statusMessage: '生产环境上游必须使用 HTTPS' })
  }
  return target.toString()
}
