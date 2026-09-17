import { useDb, type TaskRecord } from '~~/server/utils/db'
import { serializeTask } from '~~/server/utils/serialize'
import { loadTaskRefs } from '~~/server/utils/refs'
import { requireUserId } from '~~/server/utils/auth'
import { pollAsyncOnce, buildPollUrl } from '~~/server/utils/adapters'
import { persistTerminal } from '~~/server/utils/taskrunner'

interface JoinedRow extends TaskRecord {
  provider_base_url: string | null
  provider_api_key: string | null
  live_provider_name: string | null
  live_model_name: string | null
  model_keys: string | null
  model_str_id: string | null
}

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  const id = Number(getRouterParam(event, 'id'))
  if (!id || Number.isNaN(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid id' })
  }

  const db = useDb()
  const row = await db.prepare(`
    SELECT t.*,
           p.base_url AS provider_base_url,
           p.api_key AS provider_api_key,
           p.name AS live_provider_name,
           COALESCE(m.display_name, m.model_id) AS live_model_name,
           m.keys AS model_keys,
           m.model_id AS model_str_id
    FROM tasks t
    LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
    LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
    WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL
  `).get(id, userId) as JoinedRow | null

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  }

  if (!row.remote_task_id) {
    throw createError({ statusCode: 400, statusMessage: '该任务缺少远程任务 ID，无法查询上游状态' })
  }

  if (!['doubao-video', 'openai-async'].includes(row.api_format)) {
    throw createError({ statusCode: 400, statusMessage: '仅异步协议任务支持远程状态查询' })
  }

  if (!row.provider_base_url) {
    throw createError({ statusCode: 400, statusMessage: '关联平台配置不存在，无法构造查询请求' })
  }

  // 模型独立 key 优先，否则使用平台 key
  let apiKey = row.provider_api_key || ''
  if (row.model_keys) {
    try {
      const parsed = JSON.parse(row.model_keys) as { key: string; enabled?: boolean }[]
      const first = Array.isArray(parsed) ? parsed.find((k) => k.enabled !== false && k.key) : null
      if (first?.key) apiKey = first.key
    } catch { /* ignore */ }
  }
  if (!apiKey) {
    throw createError({ statusCode: 400, statusMessage: '缺少有效 API Key，无法查询上游状态' })
  }

  // 提取或重构轮询 URL
  let pollUrl: string | null = null
  if (row.response_payload) {
    try {
      const parsed = typeof row.response_payload === 'string' ? JSON.parse(row.response_payload) : row.response_payload
      if (parsed?.poll_url && typeof parsed.poll_url === 'string') {
        pollUrl = parsed.poll_url
      }
    } catch { /* ignore */ }
  }
  if (!pollUrl) {
    pollUrl = buildPollUrl(row.api_format, row.provider_base_url, row.kind, row.remote_task_id)
  }

  // 执行单次轮询判读
  const outcome = await pollAsyncOnce({ format: row.api_format, apiKey, pollUrl })

  if (outcome.kind === 'done') {
    await persistTerminal(
      row.id,
      {
        ...outcome.result,
        remote_task_id: row.remote_task_id,
        response_payload: { poll_url: pollUrl, polls: [outcome.poll] },
      },
      Date.now() - row.created_at,
      row.kind,
    )
  } else if (outcome.kind === 'error') {
    await persistTerminal(
      row.id,
      {
        ...outcome.result,
        remote_task_id: row.remote_task_id,
        response_payload: { poll_url: pollUrl, polls: [] },
      },
      Date.now() - row.created_at,
      row.kind,
    )
  } else if (outcome.kind === 'continue') {
    // 上游仍在生成中：回写最新轮询快照
    try {
      const existingPayload = typeof row.response_payload === 'string'
        ? JSON.parse(row.response_payload)
        : (row.response_payload || {})
      const polls = Array.isArray(existingPayload.polls) ? existingPayload.polls : []
      polls.push(outcome.poll)
      const updatedPayload = { ...existingPayload, poll_url: pollUrl, polls }
      await db.prepare('UPDATE tasks SET response_payload = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(JSON.stringify(updatedPayload), Date.now(), row.id, userId)
    } catch (err) {
      console.error(`[sync] 更新任务 #${row.id} response_payload 失败:`, err)
    }
  }

  // 回查并返回最新任务数据
  const updatedRow = await db.prepare(`
    SELECT t.*,
           p.base_url AS provider_base_url,
           p.name AS live_provider_name,
           COALESCE(m.display_name, m.model_id) AS live_model_name
    FROM tasks t
    LEFT JOIN providers p ON p.id = t.provider_id AND p.user_id = t.user_id
    LEFT JOIN models m ON m.id = t.model_id AND m.user_id = t.user_id
    WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL
  `).get(id, userId) as JoinedRow | null

  if (!updatedRow) {
    throw createError({ statusCode: 404, statusMessage: '任务不存在' })
  }

  const refsMap = await loadTaskRefs([id], userId)
  const refs = refsMap.get(id)

  return {
    ...serializeTask(updatedRow, {
      providerBaseUrl: updatedRow.provider_base_url,
      providerName: updatedRow.live_provider_name,
      modelName: updatedRow.live_model_name,
    }),
    refs,
    sync_outcome: outcome.kind,
  }
})
