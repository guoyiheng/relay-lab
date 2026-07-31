/**
 * 前端埋点：页面停留 / 按钮点击 / 媒体交互等事件收集后批量上报 /api/analytics。
 * 用 idle 回调 + 定时批量发送，避免阻塞主线程。仅供内部（xxn）分析页消费。
 */
import { useCurrentUser } from './useAuth'

// 轻量级埋点追踪
// 使用 requestIdleCallback 或 setTimeout 延迟发送，避免阻塞主线程
// 批量发送以减少请求次数

interface TrackEvent {
  event_type: string
  event_name: string
  page?: string
  element?: string
  metadata?: Record<string, unknown>
  duration_ms?: number
}

let eventQueue: TrackEvent[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_INTERVAL = 5000 // 5秒批量发送
const MAX_QUEUE_SIZE = 10 // 最多缓存10条事件

function flushQueue() {
  if (eventQueue.length === 0) return
  const events = [...eventQueue]
  eventQueue = []

  events.forEach((event) => {
    $fetch('/api/analytics/track', {
      method: 'POST',
      body: event,
    }).catch(() => {
      // 静默失败，不影响用户体验
    })
  })
}

export function trackEvent(event: TrackEvent) {
  const me = useCurrentUser()
  if (!me.value) return // 未登录不追踪

  eventQueue.push(event)

  if (eventQueue.length >= MAX_QUEUE_SIZE) {
    flushQueue()
  } else if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushQueue()
      flushTimer = null
    }, FLUSH_INTERVAL)
  }
}

// 页面停留时长追踪
let pageStartTime = 0
let pageTrackingEnabled = false

export function startPageTracking(page: string) {
  pageStartTime = Date.now()
  pageTrackingEnabled = true
}

export function endPageTracking(page: string) {
  if (!pageTrackingEnabled) return
  const duration = Date.now() - pageStartTime
  trackEvent({
    event_type: 'page',
    event_name: 'page_view',
    page,
    duration_ms: duration,
  })
  pageTrackingEnabled = false
}

// 按钮点击追踪
export function trackButtonClick(element: string, metadata?: Record<string, unknown>) {
  trackEvent({
    event_type: 'click',
    event_name: 'button_click',
    element,
    metadata,
  })
}

// 图片放大追踪
export function trackImageZoom(url: string, metadata?: Record<string, unknown>) {
  trackEvent({
    event_type: 'interaction',
    event_name: 'image_zoom',
    element: 'image_viewer',
    metadata: { url, ...metadata },
  })
}

// 视频播放追踪
export function trackVideoPlay(url: string, metadata?: Record<string, unknown>) {
  trackEvent({
    event_type: 'interaction',
    event_name: 'video_play',
    element: 'video_player',
    metadata: { url, ...metadata },
  })
}

// 素材下载追踪
export function trackAssetDownload(kind: string, metadata?: Record<string, unknown>) {
  trackEvent({
    event_type: 'action',
    event_name: 'asset_download',
    element: 'download_button',
    metadata: { kind, ...metadata },
  })
}

// 页面卸载时刷新队列
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    flushQueue()
  })
}
