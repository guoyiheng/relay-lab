import { getRouterParam } from 'h3'
import { useDb } from '~~/server/utils/db'
import { mutateTaskAnalysis, runAnalysisJob, type AnalysisType } from '~~/server/utils/analysis'
import { requireUserId } from '~~/server/utils/auth'

// 启动一次「异步分析」：立刻把 jobs[type]=running 落库并返回最新 analysis，
// 真正的模型调用 fire-and-forget 在后台跑，完成后写回结果（或错误）。
// 前端轮询 GET /api/tasks/{id} 直到 jobs[type] 消失 → 即可渲染结果。
// 刷新页面时若 DB 里仍有 running，前端会自动恢复轮询，任务不丢。
export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const taskId = Number(getRouterParam(event, 'id'))
  if (!taskId || Number.isNaN(taskId)) throw createError({ statusCode: 400, statusMessage: 'Invalid task id' })
  const body = await readBody<{ type?: AnalysisType }>(event)
  const type: AnalysisType = body?.type === 'sensitive' ? 'sensitive' : 'structured'

  const db = useDb()
  const row = await db.prepare('SELECT prompt, kind FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL').get(taskId, userId) as { prompt: string | null; kind: string } | null
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Task not found' })
  const prompt = (row.prompt || '').trim()
  if (!prompt) throw createError({ statusCode: 400, statusMessage: '该任务无提示词' })
  const kind: 'image' | 'video' = row.kind === 'video' ? 'video' : 'image'

  // 标记 running（去掉旧的同类 error）。
  const next = await mutateTaskAnalysis(taskId, userId, (cur) => ({
    ...cur,
    jobs: { ...(cur.jobs || {}), [type]: { status: 'running' } },
  }))

  // 后台跑模型：单次 chat（秒级），用 waitUntil 延长请求生命期在 Worker 上跑完，
  // 完成后写回结果/错误。前端轮询 GET /api/tasks/{id} 直到 jobs[type] 消失。
  const job = runAnalysisJob(taskId, userId, type, prompt, kind)
  const waitUntil = (event.context as any).waitUntil as ((p: Promise<unknown>) => void) | undefined
  if (waitUntil) waitUntil(job); else void job

  return { ok: true, analysis: next }
})
