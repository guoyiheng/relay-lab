type CaptureMedia = HTMLMediaElement & { captureStream?: () => MediaStream }

export interface ClipMediaOptions {
  url: string
  kind: 'video' | 'audio'
  start: number
  end: number
  filename: string | null
  signal: AbortSignal
  onProgress: (message: string) => void
}

// Each wait is bounded and removes its listeners, including on cancellation.
function waitForMedia(media: HTMLMediaElement, event: string, signal: AbortSignal, action: () => void) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer)
      media.removeEventListener(event, done)
      media.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      error ? reject(error) : resolve()
    }
    const done = () => finish()
    const failed = () => finish(new Error('无法读取媒体，请检查文件格式或重新添加素材'))
    const aborted = () => finish(new DOMException('截取已取消', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('读取媒体超时，请重试')), 30_000)
    media.addEventListener(event, done, { once: true })
    media.addEventListener('error', failed, { once: true })
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) { aborted(); return }
    try { action() } catch (error) { finish(error) }
  })
}

async function fetchSource(url: string, signal: AbortSignal) {
  // A playable remote URL is not necessarily capturable (CORS). Download bytes
  // first; the existing authenticated proxy only accepts assets owned by the user.
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(60_000)])
  try {
    const response = await fetch(url, { signal: boundedSignal })
    if (response.ok) return await response.blob()
  } catch (error) {
    if (boundedSignal.aborted) throw error
  }
  if (!/^https?:\/\//i.test(url)) throw new Error('无法读取原素材，请重新添加后截取')
  const response = await fetch(`/api/assets/download?url=${encodeURIComponent(url)}`, { signal: boundedSignal })
  if (!response.ok) throw new Error('无法读取远程素材，请下载后重新上传再截取')
  return response.blob()
}

function recordRange(media: HTMLMediaElement, stream: MediaStream, mime: string, options: ClipMediaOptions): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const recorder = new MediaRecorder(stream, { mimeType: mime })
    const chunks: Blob[] = []
    let stopping = false
    let failure: Error | undefined
    const cleanup = () => {
      clearInterval(timer)
      clearTimeout(deadline)
      clearTimeout(stopDeadline)
      media.removeEventListener('ended', ended)
      media.removeEventListener('error', failed)
      media.removeEventListener('pause', paused)
      options.signal.removeEventListener('abort', aborted)
    }
    let stopDeadline: ReturnType<typeof setTimeout> | undefined
    const stop = (error?: Error) => {
      if (stopping) return
      stopping = true
      failure = error
      media.pause()
      if (recorder.state === 'inactive') {
        cleanup()
        reject(error || new Error('录制未启动，请重试'))
        return
      }
      stopDeadline = setTimeout(() => { cleanup(); reject(new Error('生成文件超时，请重试')) }, 10_000)
      recorder.stop()
    }
    const tick = () => {
      if (stopping) return
      const fraction = (media.currentTime - options.start) / (options.end - options.start)
      options.onProgress(`正在截取 ${Math.min(99, Math.max(0, Math.floor(fraction * 100)))}%`)
      if (media.currentTime >= options.end) stop()
    }
    const ended = () => stop(media.currentTime < options.end - 0.15 ? new Error('媒体提前结束，未替换原素材') : undefined)
    const failed = () => stop(new Error('媒体播放失败，未替换原素材'))
    const paused = () => { if (!stopping && !media.ended) stop(new Error('截取播放被中断，请重试')) }
    const aborted = () => stop(new DOMException('截取已取消', 'AbortError'))
    const timer = setInterval(tick, 25)
    const deadline = setTimeout(() => stop(new Error('截取超时，请保持页面打开后重试')), (options.end - options.start) * 1000 + 30_000)
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data) }
    recorder.onerror = () => stop(new Error('录制失败，未替换原素材'))
    recorder.onstop = () => {
      cleanup()
      if (failure) { reject(failure); return }
      const blob = new Blob(chunks, { type: recorder.mimeType || mime })
      if (!blob.size) reject(new Error('截取结果为空，未替换原素材'))
      else resolve(blob)
    }
    media.addEventListener('ended', ended)
    media.addEventListener('error', failed)
    media.addEventListener('pause', paused)
    options.signal.addEventListener('abort', aborted, { once: true })
    if (options.signal.aborted) { aborted(); return }
    try {
      recorder.start(100)
      void media.play().catch(() => stop(new Error('无法播放素材进行截取，请重试')))
    } catch (error) { cleanup(); reject(error) }
  })
}

export async function clipMediaFile(options: ClipMediaOptions): Promise<File> {
  if (!Number.isFinite(options.start) || !Number.isFinite(options.end) || options.start < 0 || options.end <= options.start) {
    throw new Error('请选择有效的开始和结束时间')
  }
  const candidates = options.kind === 'video'
    ? ['video/mp4;codecs=avc1.42001E,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/ogg;codecs=opus']
  const mime = candidates.find((type) => globalThis.MediaRecorder?.isTypeSupported(type))
  const media = document.createElement(options.kind) as CaptureMedia
  if (!mime || !media.captureStream) throw new Error('当前浏览器不支持截取，请使用最新版 Chrome 或 Edge')
  let objectUrl: string | undefined
  let stream: MediaStream | undefined
  try {
    options.onProgress('正在读取原素材…')
    const blob = await fetchSource(options.url, options.signal)
    options.signal.throwIfAborted()
    objectUrl = URL.createObjectURL(blob)
    media.preload = 'auto'
    media.muted = true
    media.setAttribute('playsinline', '')
    // The independent player has no preview handlers that could rewind it.
    await waitForMedia(media, 'loadeddata', options.signal, () => { media.src = objectUrl!; media.load() })
    if (Number.isFinite(media.duration) && options.end > media.duration + 0.15) throw new Error('截取区间超过媒体时长')
    options.onProgress('正在定位开始位置…')
    if (options.start > 0) await waitForMedia(media, 'seeked', options.signal, () => { media.currentTime = options.start })
    stream = media.captureStream()
    if (!stream.getTracks().length || (options.kind === 'video' && !stream.getVideoTracks().length)) {
      throw new Error('无法获取媒体内容，请重新上传素材后重试')
    }
    const result = await recordRange(media, stream, mime, options)
    options.signal.throwIfAborted()
    const ext = result.type.includes('mp4') ? (options.kind === 'video' ? 'mp4' : 'm4a') : result.type.includes('ogg') ? 'ogg' : 'webm'
    const base = (options.filename || `${options.kind}-reference`).replace(/\.[^.]+$/, '')
    return new File([result], `${base}-clip.${ext}`, { type: result.type })
  } finally {
    media.pause()
    stream?.getTracks().forEach((track) => track.stop())
    media.removeAttribute('src')
    media.load()
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}
