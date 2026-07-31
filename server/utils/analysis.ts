import { findChatModel, chatComplete, stripJsonFences, resolveModelKey } from '~~/server/utils/llm'
import { useDb } from '~~/server/utils/db'

// 分析类型与持久化结构（与前端 TaskDetail 共享语义）：
//   - 结构化分析结果存在 analysis 顶层（structured/highlights/segments，向后兼容）
//   - 敏感词分析结果挂在 analysis.sensitive
//   - 进行中/失败状态挂在 analysis.jobs[type]，成功后删除该 job 键
// 这样刷新页面也能从 DB 恢复「分析中」状态并继续轮询，不丢任务。
export type AnalysisType = 'structured' | 'sensitive'

export interface StructuredResult { structured: string; highlights: string[]; segments: { label: string; text: string }[] }
export interface SensitiveResult { corrected: string; items: { original: string; replacement: string; reason?: string }[] }
export interface JobState { status: 'running' | 'error'; error?: string }
export interface StoredAnalysis {
  structured?: string
  highlights?: string[]
  segments?: { label: string; text: string }[]
  sensitive?: SensitiveResult
  jobs?: Partial<Record<AnalysisType, JobState>>
}

// 显式凭证版（在线从 DB 解析 provider/model，离线代理由客户端传入），逻辑单一来源。
export interface ChatCreds { baseUrl: string; apiKey: string; model: string }

// 跑结构化分析（直白客观、机器可解析的结构化提示词）。
export async function runStructured(userId: number, prompt: string, kind: 'image' | 'video'): Promise<StructuredResult> {
  const found = await findChatModel(userId)
  if (!found) throw createError({ statusCode: 400, statusMessage: '未找到可用文本模型，请先在平台页配置一个文本模型' })
  return runStructuredWith(prompt, kind, { baseUrl: found.provider.base_url, apiKey: resolveModelKey(found.provider, found.model), model: found.model.model_id })
}

export async function runStructuredWith(prompt: string, kind: 'image' | 'video', creds: ChatCreds): Promise<StructuredResult> {
  const taskLabel = kind === 'image' ? '文生图' : '文生视频'
  const system = `你的任务是把用户输入的杂乱${taskLabel}提示词，整理成结构化、机器易解析的提示词。`
    + `要求：用直白、客观的描述，只陈述画面里的事实要素（主体、动作、数量、位置、颜色、背景、镜头、光线等），`
    + `不要使用文学化、抒情或修饰性词汇（如"宛如""仿佛""唯美""震撼"等），不要加入用户没有提到的主观感受。`
    + `目的是让生成模型准确理解，而不是给人阅读。`
    + `只返回严格的 JSON（不要 markdown 代码块、不要额外说明），格式如下：`
    + `{ "structured": "<整理后的完整结构化提示词，直白客观>", `
    + `"highlights": ["<结构化提示词里的关键名词/属性>", ...], `
    + `"segments": [{ "label": "<要素类别，如 主体/数量/动作/场景/镜头/光线>", "text": "<该要素的直白描述>" }] }`
  const raw = await chatComplete({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: creds.model,
    system,
    user: prompt,
    temperature: 0.3,
  })
  try {
    const obj = JSON.parse(stripJsonFences(raw))
    if (!obj || typeof obj !== 'object') throw new Error('not object')
    return {
      structured: typeof obj.structured === 'string' ? obj.structured : raw,
      highlights: Array.isArray(obj.highlights) ? obj.highlights : [],
      segments: Array.isArray(obj.segments) ? obj.segments : [],
    }
  } catch {
    return { structured: raw, highlights: [], segments: [] }
  }
}

// 跑敏感词分析（找出可能触发审核的描述，给出不改原意的中性替换）。
export async function runSensitive(userId: number, prompt: string, kind: 'image' | 'video'): Promise<SensitiveResult> {
  const found = await findChatModel(userId)
  if (!found) throw createError({ statusCode: 400, statusMessage: '未找到可用文本模型，请先在平台页配置一个文本模型' })
  return runSensitiveWith(prompt, kind, { baseUrl: found.provider.base_url, apiKey: resolveModelKey(found.provider, found.model), model: found.model.model_id })
}

export async function runSensitiveWith(prompt: string, kind: 'image' | 'video', creds: ChatCreds): Promise<SensitiveResult> {
  const taskLabel = kind === 'image' ? '文生图' : '文生视频'
  const system = `你的任务是审查用户输入的${taskLabel}提示词，找出其中可能触发内容审核的敏感描述`
    + `（如血腥、暴力、色情、违禁、政治敏感等），并给出不改变画面原意的替换写法。`
    + `替换原则：用更中性、客观的描述替代可能敏感的词，尽量保留原画面意图。`
    + `例如"血腥"替换为"红色液体"、"尸体"替换为"倒地的人物"等，做类似处理以提高审核通过率。`
    + `只返回严格的 JSON（不要 markdown 代码块、不要额外说明），格式如下：`
    + `{ "corrected": "<把所有敏感词替换后的完整提示词>", `
    + `"items": [{ "original": "<原敏感词/短语，必须是提示词中的原文子串>", "replacement": "<替换后的中性描述>", "reason": "<简短原因>" }] }`
    + `如果没有发现任何敏感内容，corrected 直接返回原提示词，items 返回空数组。`
  const raw = await chatComplete({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    model: creds.model,
    system,
    user: prompt,
    temperature: 0.3,
  })
  try {
    const obj = JSON.parse(stripJsonFences(raw))
    if (!obj || typeof obj !== 'object') throw new Error('not object')
    return {
      corrected: typeof obj.corrected === 'string' ? obj.corrected : prompt,
      items: Array.isArray(obj.items)
        ? obj.items.filter((x: any) => x && typeof x.original === 'string' && typeof x.replacement === 'string')
        : [],
    }
  } catch {
    return { corrected: prompt, items: [] }
  }
}

// 原子读-改-写任务的 analysis 字段。D1 无交互式事务，这里是「读→合并→写」两步；
// 分析 job 频率极低、单任务串行，够用。merge 收到当前已存的 analysis，返回合并后的新值。
export async function mutateTaskAnalysis(taskId: number, userId: number, merge: (cur: StoredAnalysis) => StoredAnalysis): Promise<StoredAnalysis | null> {
  const db = useDb()
  const row = await db.prepare('SELECT analysis FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(taskId, userId) as { analysis: string | null } | null
  if (!row) return null
  let cur: StoredAnalysis = {}
  if (row.analysis) { try { cur = JSON.parse(row.analysis) || {} } catch { cur = {} } }
  const next = merge(cur)
  await db.prepare('UPDATE tasks SET analysis = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(JSON.stringify(next), Date.now(), taskId, userId)
  return next
}

// 后台执行一次分析：先标记 running（由调用方完成），这里跑模型并写回结果/错误。
export async function runAnalysisJob(taskId: number, userId: number, type: AnalysisType, prompt: string, kind: 'image' | 'video') {
  try {
    if (type === 'structured') {
      const res = await runStructured(userId, prompt, kind)
      await mutateTaskAnalysis(taskId, userId, (cur) => {
        const jobs = { ...(cur.jobs || {}) }
        delete jobs[type]
        return { ...cur, structured: res.structured, highlights: res.highlights, segments: res.segments, jobs }
      })
    } else {
      const res = await runSensitive(userId, prompt, kind)
      await mutateTaskAnalysis(taskId, userId, (cur) => {
        const jobs = { ...(cur.jobs || {}) }
        delete jobs[type]
        return { ...cur, sensitive: res, jobs }
      })
    }
  } catch (err: any) {
    const msg = err?.statusMessage || err?.message || '分析失败'
    await mutateTaskAnalysis(taskId, userId, (cur) => ({ ...cur, jobs: { ...(cur.jobs || {}), [type]: { status: 'error', error: msg } } }))
  }
}
