import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: null as any,
  poll: vi.fn(), persistTerminal: vi.fn(), resumeTaskPolling: vi.fn(),
}))
vi.mock('../server/utils/db', () => ({ useDb: () => mocks.db }))
vi.mock('../server/utils/auth', () => ({ requireUserId: () => 1 }))
vi.mock('../server/utils/refs', () => ({ loadTaskRefs: async () => new Map() }))
vi.mock('../server/utils/serialize', () => ({ serializeTask: (row: any) => row }))
vi.mock('../server/utils/adapters', () => ({ pollAsyncOnce: mocks.poll, buildPollUrl: () => 'https://example.com/tasks/remote-1' }))
vi.mock('../server/utils/taskrunner', () => ({ persistTerminal: mocks.persistTerminal, resumeTaskPolling: mocks.resumeTaskPolling }))
import { isStaleRunning, reapStaleTasks } from '../server/utils/reaper'

let sqlite: DatabaseSync
let sync: (event: any) => Promise<any>
beforeEach(async () => {
  vi.clearAllMocks()
  sqlite = new DatabaseSync(':memory:')
  mocks.db = sqlite
  sqlite.exec(`
    CREATE TABLE tasks (id INTEGER, user_id INTEGER, provider_id INTEGER, model_id INTEGER,
      status TEXT, kind TEXT, api_format TEXT, remote_task_id TEXT, response_payload TEXT,
      error_message TEXT, finished_at INTEGER, created_at INTEGER, updated_at INTEGER,
      latency_ms INTEGER, http_status INTEGER, deleted_at INTEGER);
    CREATE TABLE providers (id INTEGER, user_id INTEGER, base_url TEXT, api_key TEXT, name TEXT);
    CREATE TABLE models (id INTEGER, user_id INTEGER, display_name TEXT, model_id TEXT, keys TEXT);
    INSERT INTO providers VALUES (1, 1, 'https://example.com', 'test-key', 'Seedance');
    INSERT INTO models VALUES (1, 1, 'Seedance', 'seedance', NULL);
    INSERT INTO tasks VALUES (1, 1, 1, 1, 'failed', 'video', 'doubao-video', 'remote-1',
      '{"polls":[{"status":"running"}]}', 'local timeout', 100, 1, 100, 99, 500, NULL);
  `)
  vi.stubGlobal('defineEventHandler', (handler: unknown) => handler)
  vi.stubGlobal('getRouterParam', () => '1')
  vi.stubGlobal('createError', (value: any) => Object.assign(new Error(value.statusMessage), value))
  sync = (await import('../server/api/tasks/[id]/sync.post')).default
})
afterEach(() => { sqlite.close(); vi.unstubAllGlobals() })

describe('manual upstream status recovery', () => {
  it('replaces a local timeout with running and restarts polling without resubmitting', async () => {
    mocks.poll.mockResolvedValue({ kind: 'continue', poll: { status: 'running' } })
    const result = await sync({ context: {} })
    expect(result).toMatchObject({ status: 'running', error_message: null, finished_at: null, latency_ms: null, http_status: null })
    expect(JSON.parse(result.response_payload).polls).toEqual([{ status: 'running' }])
    expect(mocks.resumeTaskPolling).toHaveBeenCalledWith(1, 'https://example.com/tasks/remote-1', expect.any(Number), undefined)
    expect(mocks.persistTerminal).not.toHaveBeenCalled()
    expect(isStaleRunning(result, Date.now())).toBe(false)
    expect(await reapStaleTasks([result], 1)).toEqual([])
  })

  it('recovers even when the old response snapshot is malformed', async () => {
    sqlite.prepare('UPDATE tasks SET response_payload = ?').run('{invalid')
    mocks.poll.mockResolvedValue({ kind: 'continue', poll: { status: 'running' } })
    expect((await sync({ context: {} })).status).toBe('running')
  })

  it('does not restart a task that is already running', async () => {
    sqlite.exec("UPDATE tasks SET status = 'running'")
    mocks.poll.mockResolvedValue({ kind: 'continue', poll: { status: 'running' } })
    expect((await sync({ context: {} })).status).toBe('running')
    expect(mocks.resumeTaskPolling).not.toHaveBeenCalled()
  })

  it('preserves a success written while the manual query is in flight', async () => {
    mocks.poll.mockImplementation(async () => {
      sqlite.exec("UPDATE tasks SET status = 'succeeded'")
      return { kind: 'continue', poll: { status: 'running' } }
    })
    expect((await sync({ context: {} })).status).toBe('succeeded')
    expect(mocks.resumeTaskPolling).not.toHaveBeenCalled()
  })

  it.each(['transient', 'error'])('reports a %s query failure without declaring an upstream task failure', async (kind) => {
    mocks.poll.mockResolvedValue({ kind, result: { error_message: 'query failed' } })
    await expect(sync({ context: {} })).rejects.toMatchObject({ statusCode: 502 })
    expect(mocks.persistTerminal).not.toHaveBeenCalled()
    expect(mocks.resumeTaskPolling).not.toHaveBeenCalled()
  })

  it('still persists an actual upstream failed terminal state', async () => {
    mocks.poll.mockResolvedValue({ kind: 'done', poll: { status: 'failed' }, result: { status: 'failed', error_message: 'upstream rejected' } })
    await sync({ context: {} })
    expect(mocks.persistTerminal).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'failed', error_message: 'upstream rejected' }), expect.any(Number), 'video')
    expect(mocks.resumeTaskPolling).not.toHaveBeenCalled()
  })
})

describe('stale task recovery guard', () => {
  it('still reaps abandoned tasks after the inactivity limit', async () => {
    sqlite.exec("UPDATE tasks SET status = 'running'")
    const row = sqlite.prepare('SELECT * FROM tasks').get() as any
    expect(await reapStaleTasks([row], 1, 700_000)).toEqual([1])
    expect(row.status).toBe('failed')
    expect(sqlite.prepare('SELECT status FROM tasks').get()?.status).toBe('failed')
  })

  it('does not overwrite a task refreshed after the stale read', async () => {
    sqlite.exec("UPDATE tasks SET status = 'running'")
    const row = sqlite.prepare('SELECT * FROM tasks').get() as any
    sqlite.exec('UPDATE tasks SET updated_at = 699999')
    expect(await reapStaleTasks([row], 1, 700_000)).toEqual([])
    expect(row.status).toBe('running')
    expect(sqlite.prepare('SELECT status FROM tasks').get()?.status).toBe('running')
  })
})
