import { describe, expect, it } from 'vitest'
import { buildRequestPayload, type AdapterContext } from '../server/utils/adapters'

describe('buildRequestPayload for doubao-video image (Seedream)', () => {
  const baseCtx: AdapterContext = {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'test-key',
    modelId: 'ep-test-seedream',
    kind: 'image',
    prompt: 'A cute cat',
    params: {},
    refs: { image: [], video: [], audio: [] },
  }

  it('defaults watermark to false when watermark is omitted', () => {
    const payload = buildRequestPayload('doubao-video', baseCtx)
    expect(payload.watermark).toBe(false)
    expect(payload.size).toBe('2K')
    expect(payload.response_format).toBe('url')
    expect(payload.stream).toBe(false)
  })

  it('preserves watermark: true when explicitly provided', () => {
    const payload = buildRequestPayload('doubao-video', {
      ...baseCtx,
      params: { watermark: true },
    })
    expect(payload.watermark).toBe(true)
  })

  it('preserves watermark: false when explicitly provided', () => {
    const payload = buildRequestPayload('doubao-video', {
      ...baseCtx,
      params: { watermark: false },
    })
    expect(payload.watermark).toBe(false)
  })
})

describe('buildPollUrl', () => {
  it('builds correct pollUrl for doubao-video', async () => {
    const { buildPollUrl } = await import('../server/utils/adapters')
    const url = buildPollUrl('doubao-video', 'https://ark.cn-beijing.volces.com/api/v3', 'video', 'cgt-12345')
    expect(url).toBe('https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/cgt-12345')
  })

  it('builds correct pollUrl for openai-async video', async () => {
    const { buildPollUrl } = await import('../server/utils/adapters')
    const url = buildPollUrl('openai-async', 'https://api.example.com/v1', 'video', 'task-abc')
    expect(url).toBe('https://api.example.com/v1/videos/tasks/task-abc')
  })

  it('builds correct pollUrl for openai-async image', async () => {
    const { buildPollUrl } = await import('../server/utils/adapters')
    const url = buildPollUrl('openai-async', 'https://api.example.com/v1', 'image', 'task-def')
    expect(url).toBe('https://api.example.com/v1/images/tasks/task-def')
  })
})

describe('interpretPoll for doubao-video', () => {
  it('interprets succeeded doubao-video response', async () => {
    const { interpretPoll } = await import('../server/utils/adapters')
    const outcome = interpretPoll('doubao-video', {
      status: 'succeeded',
      content: { video_url: 'https://example.com/video.mp4' },
    })
    expect(outcome.done).toBe(true)
    if (outcome.done) {
      expect(outcome.result.status).toBe('succeeded')
      expect(outcome.result.result_urls).toEqual(['https://example.com/video.mp4'])
    }
  })

  it('interprets running doubao-video response', async () => {
    const { interpretPoll } = await import('../server/utils/adapters')
    const outcome = interpretPoll('doubao-video', {
      status: 'running',
    })
    expect(outcome.done).toBe(false)
  })

  it('interprets failed doubao-video response', async () => {
    const { interpretPoll } = await import('../server/utils/adapters')
    const outcome = interpretPoll('doubao-video', {
      status: 'failed',
      error: { message: 'Generation failed due to moderation' },
    })
    expect(outcome.done).toBe(true)
    if (outcome.done) {
      expect(outcome.result.status).toBe('failed')
      expect(outcome.result.error_message).toBe('Generation failed due to moderation')
    }
  })
})

