import { describe, expect, it, vi } from 'vitest'
import { buildRequestPayload, runAdapter, submitAsyncTask, type AdapterContext } from '../server/utils/adapters'

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

  it('keeps watermark disabled when an old parameter enables it', () => {
    const payload = buildRequestPayload('doubao-video', {
      ...baseCtx,
      params: { watermark: true },
    })
    expect(payload.watermark).toBe(false)
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

describe('video duration normalization', () => {
  const baseCtx: AdapterContext = {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: 'test-key',
    modelId: 'ep-test-video',
    kind: 'video',
    prompt: 'A cinematic shot',
    params: { duration: 30 },
    refs: { image: [], video: [], audio: [] },
  }

  it('allows 30 seconds for Seedance video', () => {
    const payload = buildRequestPayload('doubao-video', baseCtx)
    expect(payload.duration).toBe(30)
  })

  it('clamps invalid Seedance duration into the 4-30 second range', () => {
    const payload = buildRequestPayload('doubao-video', { ...baseCtx, params: { duration: 2 } })
    expect(payload.duration).toBe(4)
  })

  it.each([-1, '-1'])('preserves automatic Seedance duration %s and adaptive ratio', (duration) => {
    const payload = buildRequestPayload('doubao-video', {
      ...baseCtx,
      params: { ratio: 'adaptive', duration },
    })
    expect(payload).toMatchObject({ ratio: 'adaptive', duration: -1 })
  })

  it('keeps fixed output settings when a video is only used as reference', () => {
    const payload = buildRequestPayload('doubao-video', {
      ...baseCtx,
      params: { ratio: '9:16', duration: 20 },
      refs: { image: [], audio: [], video: [{ kind: 'video', public_url: 'https://example.com/reference.mp4' }] },
    })
    expect(payload).toMatchObject({ ratio: '9:16', duration: 20 })
  })

  it('sends identical automatic settings through in-process and queued submissions', async () => {
    const ctx: AdapterContext = {
      ...baseCtx,
      params: { ratio: 'adaptive', duration: -1, resolution: '720p', use_asset_library: true },
      segments: [
        { type: 'text', text: 'Replace the character while preserving the input video.' },
        { type: 'ref', asset: { kind: 'video', public_url: 'asset://video-1' } },
      ],
    }
    // No remote ID ends the in-process adapter before polling.
    const fetchMock = vi.fn().mockResolvedValue({})
    vi.stubGlobal('$fetch', fetchMock)
    try {
      const payload = buildRequestPayload('doubao-video', ctx)
      const result = await runAdapter('doubao-video', ctx)
      await submitAsyncTask({ format: 'doubao-video', baseUrl: ctx.baseUrl, apiKey: ctx.apiKey, kind: 'video', payload })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      for (const [, options] of fetchMock.mock.calls) {
        expect(options.body).toEqual(payload)
        expect(options.body).toMatchObject({ ratio: 'adaptive', duration: -1 })
        expect(options.body).not.toHaveProperty('use_asset_library')
      }
      expect(result.request_payload).toEqual(payload)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not apply the Seedance sentinel to OpenAI video normalization', () => {
    const payload = buildRequestPayload('openai-sync', { ...baseCtx, params: { duration: -1 } })
    expect(payload.duration).toBe(4)
  })
})

describe('buildRequestPayload for seed-audio', () => {
  const baseCtx: AdapterContext = {
    baseUrl: 'https://openspeech.bytedance.com',
    apiKey: 'test-key',
    modelId: 'seed-audio-1.0',
    kind: 'audio',
    prompt: 'Hello world speech',
    params: {},
    refs: { image: [], video: [], audio: [] },
  }

  it('builds standard audio payload with defaults', () => {
    const payload = buildRequestPayload('seed-audio', baseCtx)
    expect(payload.model).toBe('seed-audio-1.0')
    expect(payload.text_prompt).toBe('Hello world speech')
    expect(payload.audio_config).toEqual({
      format: 'mp3',
      sample_rate: 48000,
      pitch_rate: 0,
      speech_rate: 0,
      loudness_rate: 0,
    })
    expect(payload.watermark).toEqual({})
    expect(payload.references).toBeUndefined()
  })

  it('passes audio references when provided', () => {
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      refs: {
        image: [],
        video: [],
        audio: [
          { kind: 'audio', public_url: 'https://example.com/audio1.mp3' },
          { kind: 'audio', public_url: 'https://example.com/audio2.mp3' },
        ],
      },
    })
    expect(payload.references).toEqual([
      { audio_url: 'https://example.com/audio1.mp3' },
      { audio_url: 'https://example.com/audio2.mp3' },
    ])
  })

  it('puts speaker ids in references as required by Seed Audio', () => {
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      params: { speaker: 'speaker_123' },
    })
    expect(payload.references).toEqual([{ speaker: 'speaker_123' }])
    expect(payload.speaker).toBeUndefined()
  })

  it('matches the supplied nested JSON request and keeps watermark disabled', () => {
    const audio_config = { format: 'mp3', sample_rate: 48000, pitch_rate: 0, speech_rate: 0, loudness_rate: 0 }
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      params: { references: [{ speaker: 'speaker_123' }], audio_config, watermark: { aigc_watermark: true } },
    })
    expect(payload).toEqual({
      model: baseCtx.modelId,
      text_prompt: baseCtx.prompt,
      references: [{ speaker: 'speaker_123' }],
      audio_config,
      watermark: {},
    })
  })

  it('passes image reference when provided', () => {
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      refs: {
        image: [{ kind: 'image', public_url: 'https://example.com/ref.jpg' }],
        video: [],
        audio: [],
      },
    })
    expect(payload.references).toEqual([
      { image_url: 'https://example.com/ref.jpg' },
    ])
  })

  it('uses speaker reference when speaker and media are both filled', () => {
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      params: { speaker: 'speaker_123' },
      refs: {
        image: [],
        video: [],
        audio: [{ kind: 'audio', public_url: 'https://example.com/ref.mp3' }],
      },
    })
    expect(payload.references).toEqual([{ speaker: 'speaker_123' }])
  })

  it('normalizes format-specific sample rates', () => {
    const payload = buildRequestPayload('seed-audio', {
      ...baseCtx,
      params: { format: 'ogg_opus', sample_rate: 40000 },
    })
    expect(payload.audio_config).toMatchObject({ format: 'ogg_opus', sample_rate: 48000 })
  })

  it('keeps base64 audio responses as playable data URLs', async () => {
    const { runPreparedSyncTask } = await import('../server/utils/adapters')
    const fetchSpy = vi.fn().mockResolvedValueOnce({ code: 0, audio: 'QUJD' })
    vi.stubGlobal('$fetch', fetchSpy)
    const result = await runPreparedSyncTask({
      format: 'seed-audio',
      baseUrl: 'https://openspeech.bytedance.com/api/v3',
      apiKey: 'test-key',
      kind: 'audio',
      payload: { model: 'seed-audio-1.0', text_prompt: 'hello', audio_config: { format: 'wav', sample_rate: 40000 } },
    })
    expect(result.status).toBe('succeeded')
    expect(result.result_urls).toEqual(['data:audio/wav;base64,QUJD'])
    vi.unstubAllGlobals()
  })
})

describe('legacy doubao-video provider with audio model', () => {
  it('accepts audio models and uses Seed Audio compatibility routing', async () => {
    const { adapterSupportsKind, runAdapter } = await import('../server/utils/adapters')
    expect(adapterSupportsKind('doubao-video', 'audio')).toBe(true)
    expect(adapterSupportsKind('doubao-video', 'video')).toBe(true)

    const fetchMock = vi.fn().mockResolvedValue({ code: 20000000, url: 'https://example.com/audio.wav' })
    vi.stubGlobal('$fetch', fetchMock)
    const result = await runAdapter('doubao-video', {
      baseUrl: 'https://openspeech.bytedance.com',
      apiKey: 'test-key',
      modelId: 'seed-audio-1.0',
      kind: 'audio',
      prompt: 'hello',
      params: {},
      refs: { image: [], video: [], audio: [] },
    })
    expect(result.status).toBe('succeeded')
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openspeech.bytedance.com/api/v3/tts/create',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Api-Key': 'test-key' }) }),
    )
    vi.unstubAllGlobals()
  })

  it('uses X-Api-Key even when the legacy format reaches the sync runner directly', async () => {
    const { runPreparedSyncTask } = await import('../server/utils/adapters')
    const fetchMock = vi.fn().mockResolvedValue({ code: 20000000, url: 'https://example.com/audio.wav' })
    vi.stubGlobal('$fetch', fetchMock)
    await runPreparedSyncTask({
      format: 'doubao-video',
      baseUrl: 'https://openspeech.bytedance.com',
      apiKey: 'test-key',
      kind: 'audio',
      payload: { model: 'seed-audio-1.0', text_prompt: 'hello', audio_config: { format: 'mp3', sample_rate: 48000 } },
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ 'X-Api-Key': 'test-key' }))
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
    vi.unstubAllGlobals()
  })

  it('uses X-Api-Key for a full-url audio provider', async () => {
    const { runPreparedSyncTask } = await import('../server/utils/adapters')
    const fetchMock = vi.fn().mockResolvedValue({ code: 20000000, url: 'https://example.com/audio.wav' })
    vi.stubGlobal('$fetch', fetchMock)
    await runPreparedSyncTask({
      format: 'full-url',
      baseUrl: 'https://openspeech.bytedance.com/api/v3/tts/create',
      apiKey: 'test-key',
      kind: 'audio',
      payload: { model: 'seed-audio-1.0', text_prompt: 'hello', audio_config: { format: 'mp3', sample_rate: 48000 } },
    })
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual(expect.objectContaining({ 'X-Api-Key': 'test-key' }))
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty('Authorization')
    vi.unstubAllGlobals()
  })
})

describe('sanitizeAudioResponsePayload', () => {
  it('truncates very long audio base64 strings', async () => {
    const { sanitizeAudioResponsePayload } = await import('../server/utils/adapters')
    const longBase64 = 'A'.repeat(500)
    const sanitized = sanitizeAudioResponsePayload({
      duration: 3.5,
      url: 'https://example.com/out.mp3',
      audio: longBase64,
    })
    expect(sanitized.duration).toBe(3.5)
    expect(sanitized.url).toBe('https://example.com/out.mp3')
    expect(sanitized.audio).toContain('[已截断，共 500 字符]')
    expect(sanitized.audio.length).toBeLessThan(200)
  })
})
