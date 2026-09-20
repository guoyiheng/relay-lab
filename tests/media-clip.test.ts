import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clipMediaFile } from '../app/utils/clip-media'

class FakeMedia extends EventTarget {
  duration = 4
  src = ''
  preload = ''
  muted = false
  ended = false
  time = 0
  ticker?: ReturnType<typeof setInterval>
  track = { stop: vi.fn() }
  get currentTime() { return this.time }
  set currentTime(value: number) { this.time = value; queueMicrotask(() => this.dispatchEvent(new Event('seeked'))) }
  setAttribute() {}
  removeAttribute() { this.src = '' }
  load() { if (this.src) queueMicrotask(() => this.dispatchEvent(new Event('loadeddata'))) }
  captureStream() { return { getTracks: () => [this.track], getVideoTracks: () => [this.track] } }
  play() {
    this.ticker = setInterval(() => { this.time += 0.05 }, 50)
    return Promise.resolve()
  }
  pause() { clearInterval(this.ticker); this.dispatchEvent(new Event('pause')) }
}
class FakeRecorder {
  static isTypeSupported = () => true
  state = 'inactive'
  mimeType = 'video/mp4'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  onerror?: () => void
  constructor(_stream: unknown, options: { mimeType: string }) { this.mimeType = options.mimeType }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['recorded bytes']) })
    this.onstop?.()
  }
}
let media: FakeMedia
let revoke: ReturnType<typeof vi.fn>
const options = () => ({ url: 'blob:source', kind: 'video' as const, start: 1, end: 2, filename: 'source.mp4', signal: new AbortController().signal, onProgress: vi.fn() })

beforeEach(() => {
  vi.useFakeTimers()
  media = new FakeMedia()
  revoke = vi.fn()
  vi.stubGlobal('document', { createElement: () => media })
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Blob(['source']))))
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recording')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revoke)
})
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('media clipping lifecycle', () => {
  it('records an isolated range and releases all capture resources', async () => {
    const progress = vi.fn()
    const result = clipMediaFile({ ...options(), onProgress: progress })
    await vi.advanceTimersByTimeAsync(1500)
    const file = await result
    expect(file.size).toBeGreaterThan(0)
    expect(file.name).toBe('source-clip.mp4')
    expect(media.time).toBeGreaterThanOrEqual(2)
    expect(progress).toHaveBeenCalledWith(expect.stringContaining('正在截取'))
    expect(media.track.stop).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:recording')
  })
  it('cancels an active recording without returning a replacement file', async () => {
    const controller = new AbortController()
    const result = clipMediaFile({ ...options(), signal: controller.signal })
    const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(250)
    controller.abort()
    await assertion
    expect(media.track.stop).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('bounds stalled playback instead of waiting forever', async () => {
    media.play = () => Promise.resolve()
    const result = clipMediaFile(options())
    const assertion = expect(result).rejects.toThrow('截取超时')
    await vi.advanceTimersByTimeAsync(31_100)
    await assertion
    expect(media.track.stop).toHaveBeenCalledOnce()
  })
  it('reports a rejected play request and keeps the source intact', async () => {
    media.play = () => Promise.reject(new Error('blocked'))
    await expect(clipMediaFile(options())).rejects.toThrow('无法播放素材')
    expect(revoke).toHaveBeenCalledOnce()
  })
  it('uses the existing authorized download proxy for CORS failures', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockRejectedValueOnce(new TypeError('CORS'))
    const result = clipMediaFile({ ...options(), url: 'https://assets.example/video.mp4' })
    await vi.advanceTimersByTimeAsync(1500)
    await result
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/assets/download?url=https%3A%2F%2Fassets.example%2Fvideo.mp4')
  })
  it('reports unsupported capture before downloading any media', async () => {
    Object.assign(media, { captureStream: undefined })
    await expect(clipMediaFile(options())).rejects.toThrow('当前浏览器不支持截取')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects an empty recording instead of replacing the reference', async () => {
    vi.spyOn(FakeRecorder.prototype, 'stop').mockImplementation(function (this: FakeRecorder) {
      this.state = 'inactive'
      this.onstop?.()
    })
    const result = clipMediaFile(options())
    const assertion = expect(result).rejects.toThrow('截取结果为空')
    await vi.advanceTimersByTimeAsync(1500)
    await assertion
  })
})
