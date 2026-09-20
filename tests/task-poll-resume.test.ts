import { afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ send: vi.fn(), get: vi.fn(), poll: vi.fn() }))
vi.mock('../server/utils/db', () => ({
  useQueue: () => ({ send: mocks.send }),
  useDb: () => ({ prepare: () => ({ get: mocks.get }) }),
}))
vi.mock('../server/utils/adapters', () => ({ pollAsyncOnce: mocks.poll }))
import { handleTaskMessage, resumeTaskPolling } from '../server/utils/taskrunner'
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals() })

describe('resume existing remote polling', () => {
  it('enqueues a poll message without a submit phase', async () => {
    await resumeTaskPolling(1, 'https://example.com/tasks/remote-1', 123)
    expect(mocks.send).toHaveBeenCalledWith({ taskId: 1, phase: 'poll', pollUrl: 'https://example.com/tasks/remote-1', startedAt: 123 }, { delaySeconds: 5 })
  })

  it('uses the manual recovery window even for an old queued poll', async () => {
    const resumed = Date.now()
    mocks.get.mockResolvedValueOnce({
      user_id: 1, kind: 'video', api_format: 'doubao-video', provider_id: 1, model_id: 1,
      status: 'running', remote_task_id: 'remote-1', request_payload: '{}',
      response_payload: JSON.stringify({ poll_resumed_at: resumed }),
    }).mockResolvedValueOnce({ base_url: 'https://example.com' }).mockResolvedValueOnce({})
    mocks.poll.mockResolvedValue({ kind: 'continue', poll: { status: 'running' } })
    vi.stubGlobal('resolveModelKey', () => 'test-key')
    const result = await handleTaskMessage({ taskId: 1, phase: 'poll', pollUrl: 'https://example.com/tasks/remote-1', startedAt: resumed - 900_000 })
    expect(result?.next).toMatchObject({ phase: 'poll', startedAt: resumed })
    expect(mocks.poll).toHaveBeenCalledOnce()
  })
})
