/**
 * DataSource 抽象层 —— 离线/在线双模式的接缝。
 *
 * 背景：项目要支持两种使用方式（见 README / CLAUDE.md）：
 *   · 在线：配置(平台+key) / 任务 / 素材都在服务器（D1 + R2 + session），登录后用。
 *   · 离线：全部存浏览器（IndexedDB + base64），无需登录，隐私不出本机。
 *
 * 为让 UI 与业务逻辑「一份代码、两种模式、行为一致」，把所有「数据从哪来、任务怎么发」
 * 的操作收敛到此接口。stores / composables / 页面只依赖 `useDataSource()` 返回的实现，
 * 不再直接 $fetch。两个实现：
 *   · OnlineDataSource  —— 薄包现有 /api/*（本步骤先落地，保证零回归）。
 *   · OfflineDataSource —— IndexedDB + /api/proxy/*（后续步骤）。
 *
 * 方法按「业务操作」而非「HTTP 端点」命名，离线实现才能自然对接。
 */
import type {
  Provider,
  ProviderWithModels,
  ProviderInput,
  Model,
  ModelInput,
  TaskRow,
  TaskListQuery,
  TaskRunPayload,
  RefResolveItem,
  PickerAsset,
  ModelKind,
} from '~~/types/api'
import type { StatsRow } from '~/stores/history'

export type DataMode = 'online' | 'offline'

export interface DataSource {
  readonly mode: DataMode

  // ── 平台 Providers ──────────────────────────────────────────────
  listProviders(): Promise<ProviderWithModels[]>
  createProvider(input: ProviderInput): Promise<Provider>
  updateProvider(id: number, patch: Partial<ProviderInput>): Promise<Provider>
  deleteProvider(id: number): Promise<void>
  copyProvider(id: number): Promise<{ provider: { name: string }; models: number }>
  exportProviders(): Promise<unknown>
  importProviders(data: unknown): Promise<{ providers: number; models: number; errors: unknown[] }>

  // ── 模型 Models ─────────────────────────────────────────────────
  createModel(input: ModelInput): Promise<Model>
  updateModel(id: number, patch: Partial<ModelInput>): Promise<Model>
  deleteModel(id: number): Promise<void>

  // ── 任务 Tasks ──────────────────────────────────────────────────
  listTasks(query?: TaskListQuery): Promise<TaskRow[]>
  getTask(id: number): Promise<TaskRow>
  runTask(payload: TaskRunPayload): Promise<TaskRow>
  /**
   * 刷新后恢复未终态任务的轮询驱动。在线由服务端(队列/waitUntil)驱动，前端只轮询 DB，
   * 故为 no-op；离线的轮询循环在浏览器内存里，页面刷新会丢，需据持久化状态重启。
   */
  resumeTaskPolls?(tasks: TaskRow[]): void
  deleteTask(id: number): Promise<void>
  setFavorite(id: number, favorite: boolean): Promise<void>
  analyzeTask(id: number, type: 'structured' | 'sensitive'): Promise<{ analysis: unknown }>
  taskCurl(id: number): Promise<{ curl: string }>
  taskStats(): Promise<StatsRow[]>

  // ── 素材 Assets ─────────────────────────────────────────────────
  listAssets(kind?: ModelKind): Promise<PickerAsset[]>
  /** 把一批待上传/待导入的参考素材解析成 asset id；保持顺序，任一失败则整体拒绝。 */
  resolveRefIds(items: RefResolveItem[]): Promise<string[]>
  deleteAsset(id: string): Promise<void>
  deleteTaskResult(taskId: number, idx: number): Promise<void>

  // ── 提示词辅助 Prompt ────────────────────────────────────────────
  polishPrompt(input: { prompt: string; kind: ModelKind; customCommand?: string }): Promise<{ polished?: string }>
}
