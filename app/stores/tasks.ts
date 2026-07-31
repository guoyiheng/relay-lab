import { defineStore } from 'pinia'
import type { TaskRow } from '~~/types/api'

const TERMINAL = new Set(['succeeded', 'failed'])

// 合并轮询：所有未终态任务共用一个定时器，每 tick 用 GET /api/tasks?ids=... 一次
// 批量拉回，请求数从「每任务一个」降到「每 tick 一个」。退避：基础间隔随连续轮询
// 次数递增到上限，含视频任务时用更慢的基础节奏（视频出结果慢，无谓高频空轮）。
const POLL_BASE_MS = 2500        // 起始间隔（纯图/文本）
const POLL_BASE_VIDEO_MS = 5000  // 起始间隔（含视频未终态）
const POLL_MAX_MS = 15000        // 退避上限
const POLL_STEP_MS = 2500        // 每 tick 递增步长

/**
 * Caches the recent-task list shared between the console and history pages.
 * The console mounts the store, kicks off `loadAll()` once, and resumes
 * polling for any non-terminal tasks. Navigating away and back doesn't
 * refetch — `getter.isStale` decides if a refresh is worth doing.
 *
 * 轮询模型：维护一个待轮询 id 集合 + 单一定时器（合并轮询）。startPoll(id) 只是
 * 把 id 加入集合并确保定时器在跑；命中终态即从集合移除；集合空则停表。
 */
export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: [] as TaskRow[],
    // Full payloads are loaded lazily through the active data source. Online list
    // responses omit large request/response snapshots and refs to keep transfers small.
    details: {} as Record<number, TaskRow>,
    loadedAt: 0 as number,
    loading: false as boolean,
    // 待轮询任务 id 集合（未终态）。
    polling: new Set<number>(),
    // 单一合并轮询定时器句柄 + 连续轮询计数（驱动退避）。
    pollTimer: null as ReturnType<typeof setTimeout> | null,
    pollTicks: 0 as number,
  }),
  getters: {
    isStale: (s) => s.loadedAt === 0 || Date.now() - s.loadedAt > 30_000,
    detailById: (s) => (id: number | null) => id ? s.details[id] || null : null,
  },
  actions: {
    async loadAll(force = false, limit = 30) {
      if (this.loading) return
      if (!force && !this.isStale && this.tasks.length) return
      this.loading = true
      try {
        const ds = useDataSource()
        this.tasks = await ds.listTasks({ limit })
        this.loadedAt = Date.now()
        // 离线：重启浏览器侧上游轮询循环（刷新后内存循环已丢；在线为 no-op）。
        ds.resumeTaskPolls?.(this.tasks)
        // Resume polling for tasks still in-flight (running / pending)
        for (const t of this.tasks) {
          if (!TERMINAL.has(t.status)) this.startPoll(t.id)
        }
      } finally {
        this.loading = false
      }
    },
    async loadDetail(id: number, force = false): Promise<TaskRow> {
      if (!force && this.details[id]?.refs !== undefined) return this.details[id]
      const task = await useDataSource().getTask(id)
      this.details = { ...this.details, [id]: task }
      // Keep list status/result metadata synchronized without discarding the
      // full payload that was just cached.
      const idx = this.tasks.findIndex((t) => t.id === id)
      if (idx >= 0) this.tasks[idx] = { ...this.tasks[idx], ...task }
      return task
    },
    upsert(task: TaskRow) {
      const idx = this.tasks.findIndex((t) => t.id === task.id)
      const current = idx >= 0 ? this.tasks[idx] : null
      // Poll/list responses intentionally replace payload snapshots with null.
      // Preserve payloads already returned by /run or /:id instead of letting a
      // lightweight status refresh make the network panel appear body-less.
      const isSummary = task.refs === undefined
        && task.request_payload == null
        && task.response_payload == null
      const nextTask = current && isSummary
        ? {
            ...current,
            ...task,
            request_payload: current.request_payload,
            response_payload: current.response_payload,
          }
        : task
      if (idx >= 0) this.tasks[idx] = nextTask
      else this.tasks = [nextTask, ...this.tasks]

      const detail = this.details[task.id]
      if (task.refs !== undefined) {
        // Detail/run endpoints return refs, which marks this as a full payload.
        this.details = { ...this.details, [task.id]: task }
      } else if (detail) {
        // Poll/list summaries deliberately contain null request/response fields.
        // Offline polling returns complete IndexedDB rows, so accept newly
        // persisted payloads there and preserve cached values only when omitted.
        this.details = {
          ...this.details,
          [task.id]: {
            ...detail,
            ...task,
            request_payload: task.request_payload ?? detail.request_payload,
            response_payload: task.response_payload ?? detail.response_payload,
            refs: detail.refs,
          },
        }
      }
    },
    remove(id: number) {
      this.stopPoll(id)
      this.tasks = this.tasks.filter((t) => t.id !== id)
      const { [id]: _removed, ...rest } = this.details
      this.details = rest
    },
    // 把 id 移出待轮询集合；集合空则停掉合并定时器。
    stopPoll(id: number) {
      this.polling.delete(id)
      if (!this.polling.size) this.stopAllPolls()
    },
    stopAllPolls() {
      if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
      this.polling.clear()
      this.pollTicks = 0
    },
    // 注册一个待轮询任务并确保合并定时器在跑。终态任务不注册。
    startPoll(id: number) {
      const existing = this.tasks.find((t) => t.id === id)
      if (existing && TERMINAL.has(existing.status)) return
      this.polling.add(id)
      this.pollTicks = 0            // 有新任务加入，重置退避回到高频
      this.ensurePolling()
    },
    // 确保合并定时器已启动（幂等）。
    ensurePolling() {
      if (this.pollTimer || !this.polling.size) return
      this.scheduleNextTick()
    },
    // 退避间隔：基础节奏（含视频更慢）+ 随连续轮询次数线性递增，封顶 POLL_MAX_MS。
    nextGap(): number {
      const hasVideo = this.tasks.some(
        (t) => this.polling.has(t.id) && t.kind === 'video' && !TERMINAL.has(t.status),
      )
      const base = hasVideo ? POLL_BASE_VIDEO_MS : POLL_BASE_MS
      return Math.min(base + this.pollTicks * POLL_STEP_MS, POLL_MAX_MS)
    },
    scheduleNextTick() {
      this.pollTimer = setTimeout(() => { void this.pollTick() }, this.nextGap())
    },
    // 一次合并轮询：批量拉回所有待轮询任务，upsert，终态的移出集合。
    async pollTick() {
      this.pollTimer = null
      if (!this.polling.size) return
      const ids = Array.from(this.polling)
      try {
        const fresh = await useDataSource().listTasks({ ids })
        const seen = new Set<number>()
        for (const t of fresh) {
          seen.add(t.id)
          this.upsert(t)
          if (TERMINAL.has(t.status)) this.polling.delete(t.id)
        }
        // 批量返回里缺失的 id（已被删/软删/查不到）→ 停止轮询，避免空转。
        for (const id of ids) if (!seen.has(id)) this.polling.delete(id)
      } catch {
        // 单次失败不杀轮询：留待下个 tick 重试（网络抖动兜底）。
      }
      this.pollTicks++
      if (this.polling.size) this.scheduleNextTick()
      else this.stopAllPolls()
    },
  },
})
