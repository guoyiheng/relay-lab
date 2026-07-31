import { reactive } from 'vue'

/**
 * 全局打包下载进度——批量下载抓取素材 + 压缩耗时较长，需要一条底部居中的进度条兜底体感。
 *
 *   const dl = useDownloadProgress()
 *   dl.start(tasks.length, '打包下载')
 *   dl.step('打包任务 #12')   // 每完成一个任务推进一格
 *   dl.label('压缩中…')       // 压缩阶段切文案（进度条转不确定态）
 *   dl.done()                 // 收尾（组件自行延迟隐藏）
 *
 * 状态是模块级单例，由挂在 app.vue 的 <DownloadProgress> 渲染（同一时刻只有一条进度）。
 */
interface ProgressState {
  open: boolean
  title: string
  label: string
  done: number
  total: number
  /** 不确定态（如压缩阶段，无法量化 → 显示流动条而非百分比）。 */
  indeterminate: boolean
  /** 出错收尾时置 true，组件用 error 色提示。 */
  failed: boolean
}

const state = reactive<ProgressState>({
  open: false,
  title: '',
  label: '',
  done: 0,
  total: 0,
  indeterminate: false,
  failed: false,
})

let hideTimer: ReturnType<typeof setTimeout> | null = null

export function useDownloadProgressState() {
  return state
}

export function useDownloadProgress() {
  return {
    /** 开始：给出总步数与标题，立刻显示进度条。 */
    start(total: number, title = '打包下载') {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      state.title = title
      state.label = ''
      state.done = 0
      state.total = Math.max(total, 1)
      state.indeterminate = false
      state.failed = false
      state.open = true
    },
    /** 完成一步：done+1，可选更新当前文案。 */
    step(label?: string) {
      state.done = Math.min(state.done + 1, state.total)
      if (label != null) state.label = label
    },
    /** 只更新文案（不推进）；压缩这类无法量化的阶段传 indeterminate=true。 */
    label(text: string, indeterminate = false) {
      state.label = text
      state.indeterminate = indeterminate
    },
    /** 成功收尾：满格 + 短暂停留后自动隐藏。 */
    done(label = '下载已开始') {
      state.done = state.total
      state.indeterminate = false
      state.label = label
      hideTimer = setTimeout(() => { state.open = false }, 1500)
    },
    /** 失败收尾：红色提示后自动隐藏。 */
    fail(label = '下载失败') {
      state.failed = true
      state.indeterminate = false
      state.label = label
      hideTimer = setTimeout(() => { state.open = false }, 2500)
    },
  }
}
