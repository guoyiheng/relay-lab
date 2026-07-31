/**
 * 离线代理 · 生成端点（无状态转发，不落库）。
 *
 * 离线模式浏览器把完整的 adapter 上下文（baseUrl/apiKey/modelId/kind/prompt/params/
 * refs/segments，参考素材已在前端解析成 data:URL 或 web URL）发到这里，服务端复用与在线
 * 完全相同的 adapter 纯函数发上游：
 *   · 同步（text / openai-sync）→ 跑完返回终态 AdapterResult
 *   · 异步（openai-async / doubao-video）→ 只提交，返回 { pollUrl, taskId, submitResp,
 *     request_payload }，由浏览器自己轮询 /api/proxy/poll
 * 端点免鉴权（见 middleware/auth 白名单），故对 baseUrl 做 SSRF 校验。key 仅内存转发不落库。
 */
import {
  runAdapter, buildRequestPayload, submitAsyncTask, adapterSupportsKind,
  type ReferenceAsset, type OrderedSegment,
} from '~~/server/utils/adapters'
import type { ApiFormat, ModelKind } from '~~/server/utils/db'
import { assertSafeUpstreamUrl } from '~~/server/utils/proxy-guard'
import { assertBodySize } from '~~/server/utils/request-security'

interface Body {
  format: ApiFormat
  kind: ModelKind
  baseUrl: string
  apiKey: string
  modelId: string
  prompt: string
  params?: Record<string, unknown>
  refs?: { image: ReferenceAsset[]; video: ReferenceAsset[]; audio: ReferenceAsset[] }
  segments?: OrderedSegment[]
}

export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event)
  assertBodySize(body, 32 * 1024 * 1024)
  const rawBaseUrl = (body?.baseUrl || '').trim()
  if (rawBaseUrl.length > 4096) throw createError({ statusCode: 400, statusMessage: '上游 URL 过长' })
  const baseUrl = assertSafeUpstreamUrl(rawBaseUrl)
  const apiKey = (body?.apiKey || '').trim()
  const format = body?.format
  const kind = body?.kind
  const modelId = (body?.modelId || '').trim()
  const prompt = (body?.prompt || '').trim()
  if (!['openai-sync', 'openai-async', 'xai-image', 'doubao-video'].includes(format)) {
    throw createError({ statusCode: 400, statusMessage: '不支持的 API 格式' })
  }
  if (!['image', 'video', 'text'].includes(kind)) {
    throw createError({ statusCode: 400, statusMessage: '不支持的模型类型' })
  }
  if (!apiKey) throw createError({ statusCode: 400, statusMessage: '缺少 API Key' })
  if (apiKey.length > 16_384) throw createError({ statusCode: 400, statusMessage: 'API Key 过长' })
  if (!modelId) throw createError({ statusCode: 400, statusMessage: '缺少模型 ID' })
  if (modelId.length > 512) throw createError({ statusCode: 400, statusMessage: '模型 ID 过长' })
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })
  if (prompt.length > 20_000) throw createError({ statusCode: 400, statusMessage: '提示词过长' })

  const ctx = {
    baseUrl, apiKey, modelId, kind, prompt,
    params: body?.params && typeof body.params === 'object' ? body.params : {},
    refs: body?.refs || { image: [], video: [], audio: [] },
    segments: body?.segments,
  }

  const isAsync = kind !== 'text'
    && (format === 'openai-async' || format === 'doubao-video')
    && adapterSupportsKind(format, kind)
  const payload = buildRequestPayload(format, ctx)

  // 同步：一把跑完（text 短路 chat/completions；openai-sync 一次性 POST）。
  if (!isAsync) {
    const result = await runAdapter(format, ctx)
    return {
      phase: 'terminal' as const,
      result: { ...result, request_payload: result.request_payload ?? payload },
    }
  }

  // 异步：只提交，拿 taskId + pollUrl 交给浏览器轮询。
  const sub = await submitAsyncTask({ format, baseUrl, apiKey, kind, payload })
  if (!sub.ok) {
    return {
      phase: 'terminal' as const,
      result: {
        status: 'failed' as const,
        http_status: sub.http_status,
        request_payload: payload,
        response_payload: sub.submitResp,
        result_urls: [],
        error_message: sub.error_message,
      },
    }
  }
  return {
    phase: 'polling' as const,
    request_payload: payload,
    taskId: sub.taskId,
    pollUrl: sub.pollUrl,
    submitResp: sub.submitResp,
  }
})
