import {
  useDb,
  type ProviderRecord,
  type ModelRecord,
} from './db'

function joinUrl(base: string, path: string) {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function extractError(err: any): { message: string } {
  const data = err?.data || err?.response?._data
  const message
    = data?.error?.message
    || data?.message
    || data?.error
    || err?.statusMessage
    || err?.message
    || 'Request failed'
  return { message: String(message) }
}

// 润色 system 提示词构建（在线端点与离线代理共用，模板单一来源，避免重复）。
export function buildPolishSystem(kind: 'image' | 'video', customCommand?: string): string {
  const taskLabel = kind === 'image' ? '生图' : '生视频'
  const OUTPUT_RULE = `\n\n【输出要求】只返回优化后的提示词文本本身，直接可用；`
    + `不要输出任何解释、说明、前言、总结或「我做了什么」之类的内容；`
    + `不要 JSON、不要 markdown、不要引号包裹；总长度控制在 2000 字以内。`
  const base = (customCommand || '').trim()
    || `你是一位富有创意的提示词优化师，擅长为${taskLabel}模型优化提示词。`
      + `把用户输入改写成一段精炼、生动、可直接用于${taskLabel}的提示词。`
  return base + OUTPUT_RULE
}

// Synchronous OpenAI-compatible chat completion. Unlike the image/video
// adapters, chat completions are SYNC — no ?async=true, no polling.
export async function chatComplete(opts: {
  baseUrl: string
  apiKey: string
  model: string
  system?: string
  user: string
  temperature?: number
}): Promise<string> {
  const url = joinUrl(opts.baseUrl, 'chat/completions')
  const messages: { role: string; content: string }[] = []
  if (opts.system) messages.push({ role: 'system', content: opts.system })
  messages.push({ role: 'user', content: opts.user })
  const body: Record<string, unknown> = {
    model: opts.model,
    messages,
  }
  if (opts.temperature !== undefined) body.temperature = opts.temperature
  try {
    const resp = await $fetch<any>(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body,
    })
    const content = resp?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('聊天接口响应中未找到 choices[0].message.content')
    }
    return content
  } catch (err: any) {
    const e = extractError(err)
    throw new Error(e.message)
  }
}

// Locate the polish/analyze chat model: the enabled text model flagged
// `polish_model = 1` under an enabled provider. Falls back to any enabled
// model_id = 'gpt-5.5' for backward compatibility.
export async function findChatModel(userId: number): Promise<{ provider: ProviderRecord; model: ModelRecord } | null> {
  const db = useDb()
  let row = await db
    .prepare(
      `SELECT m.id AS m_id, p.id AS p_id
         FROM models m JOIN providers p ON p.id = m.provider_id
        WHERE m.user_id = ? AND p.user_id = ? AND m.polish_model = 1 AND m.enabled = 1 AND p.enabled = 1
        LIMIT 1`,
    )
    .get(userId, userId) as { m_id: number; p_id: number } | null
  if (!row) {
    row = await db
      .prepare(
        `SELECT m.id AS m_id, p.id AS p_id
           FROM models m JOIN providers p ON p.id = m.provider_id
          WHERE m.user_id = ? AND p.user_id = ? AND m.model_id = 'gpt-5.5' AND m.enabled = 1 AND p.enabled = 1
          LIMIT 1`,
      )
      .get(userId, userId) as { m_id: number; p_id: number } | null
  }
  if (!row) return null
  const provider = await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?').get(row.p_id, userId) as ProviderRecord
  const model = await db.prepare('SELECT * FROM models WHERE id = ? AND user_id = ?').get(row.m_id, userId) as ModelRecord
  return { provider, model }
}

// Model independent key takes precedence over the platform key.
export function resolveModelKey(provider: ProviderRecord, model: ModelRecord): string {
  if (model.keys) {
    try {
      const parsed = JSON.parse(model.keys) as { key: string; enabled?: boolean }[]
      const first = Array.isArray(parsed) ? parsed.find((k) => k.enabled !== false && k.key) : null
      if (first?.key) return first.key
    } catch { /* fall through */ }
  }
  return provider.api_key
}

// Strip ```json ... ``` (or plain ``` ... ```) fences a model may wrap JSON in.
export function stripJsonFences(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() ?? trimmed
}
