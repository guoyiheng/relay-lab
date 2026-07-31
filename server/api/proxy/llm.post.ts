/**
 * 离线代理 · 文本模型（润色 / 结构化分析 / 敏感词分析），无状态。
 *
 * 离线模式浏览器传入选定文本模型的 {baseUrl, apiKey, model} + 操作类型，服务端复用与在线
 * 完全相同的 system 模板与 chat 调用（buildPolishSystem / runStructuredWith / runSensitiveWith），
 * 保证离线/在线分析结果一致。免鉴权 → SSRF 校验；key 仅内存转发不落库。
 */
import { chatComplete, buildPolishSystem } from '~~/server/utils/llm'
import { runStructuredWith, runSensitiveWith } from '~~/server/utils/analysis'
import { assertSafeUpstreamUrl } from '~~/server/utils/proxy-guard'
import { assertBodySize } from '~~/server/utils/request-security'

interface Body {
  op: 'polish' | 'structured' | 'sensitive'
  baseUrl: string
  apiKey: string
  model: string
  prompt: string
  kind?: 'image' | 'video'
  customCommand?: string
}

export default defineEventHandler(async (event) => {
  const body = await readBody<Body>(event)
  assertBodySize(body, 512 * 1024)
  const rawBaseUrl = (body?.baseUrl || '').trim()
  if (rawBaseUrl.length > 4096) throw createError({ statusCode: 400, statusMessage: '上游 URL 过长' })
  const baseUrl = assertSafeUpstreamUrl(rawBaseUrl)
  const apiKey = (body?.apiKey || '').trim()
  const model = (body?.model || '').trim()
  const prompt = (body?.prompt || '').trim()
  const kind: 'image' | 'video' = body?.kind === 'video' ? 'video' : 'image'
  if (!['polish', 'structured', 'sensitive'].includes(body?.op)) {
    throw createError({ statusCode: 400, statusMessage: '未知操作' })
  }
  if (!apiKey || !model) throw createError({ statusCode: 400, statusMessage: '缺少文本模型凭证' })
  if (apiKey.length > 16_384 || model.length > 512) throw createError({ statusCode: 400, statusMessage: '文本模型凭证过长' })
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '请填写提示词' })
  if (prompt.length > 20_000 || String(body?.customCommand || '').length > 4_000) {
    throw createError({ statusCode: 400, statusMessage: '提示词或自定义指令过长' })
  }

  const creds = { baseUrl, apiKey, model }

  if (body.op === 'polish') {
    const system = buildPolishSystem(kind, body?.customCommand)
    const raw = await chatComplete({ baseUrl, apiKey, model, system, user: prompt, temperature: 0.8 })
    return { polished: (raw || '').trim().slice(0, 2000) }
  }
  if (body.op === 'structured') {
    return { result: await runStructuredWith(prompt, kind, creds) }
  }
  if (body.op === 'sensitive') {
    return { result: await runSensitiveWith(prompt, kind, creds) }
  }
  throw createError({ statusCode: 400, statusMessage: '未知操作' })
})
