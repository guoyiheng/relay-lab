/**
 * 离线代理 · 单次轮询端点（无状态）。
 *
 * 浏览器对异步任务按节奏调本端点，服务端用与在线一致的 pollAsyncOnce 判读一次上游状态，
 * 返回 done(终态,附结果) / continue(继续) / error(上游明确报错) / transient(瞬时错误,应重试)。
 * 轮询循环、超时上限、间隔全在浏览器侧掌控（对齐在线队列消费者的语义）。免鉴权 → 校验 pollUrl。
 */
import { pollAsyncOnce } from '~~/server/utils/adapters'
import type { ApiFormat } from '~~/server/utils/db'
import { assertSafeUpstreamUrl } from '~~/server/utils/proxy-guard'
import { assertBodySize } from '~~/server/utils/request-security'

interface Body {
  format: ApiFormat
  apiKey: string
  pollUrl: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event)
  assertBodySize(body, 64 * 1024)
  const rawPollUrl = (body?.pollUrl || '').trim()
  if (rawPollUrl.length > 4096) throw createError({ statusCode: 400, statusMessage: '轮询 URL 过长' })
  const pollUrl = assertSafeUpstreamUrl(rawPollUrl)
  const apiKey = (body?.apiKey || '').trim()
  const format = body?.format
  if (!['openai-async', 'doubao-video'].includes(format)) {
    throw createError({ statusCode: 400, statusMessage: '不支持的轮询格式' })
  }
  if (!apiKey) throw createError({ statusCode: 400, statusMessage: '缺少 API Key' })
  if (apiKey.length > 16_384) {
    throw createError({ statusCode: 400, statusMessage: '轮询参数过长' })
  }

  const outcome = await pollAsyncOnce({ format, apiKey, pollUrl })
  return outcome
})
