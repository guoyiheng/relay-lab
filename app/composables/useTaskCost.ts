/**
 * 任务成本计算：按模型的 price_mode（per_call / per_mtoken / per_mtoken_video）
 * 用任务行上的价格快照算出金额与公式。价格读快照不 JOIN live 模型（改价不影响历史）。
 */
import type { TaskRow, Model } from '~~/types/api'

// Seedance 旧费率（元/百万 token），仅作快照缺失时的回退。新任务用模型配置的
// per_mtoken_video 两档价快照（task.price_novideo_cny / price_video_cny）。
const SEEDANCE_RATES = {
  pro: { noVideo: 46.0, withVideo: 28.0 },
  fast: { noVideo: 37.0, withVideo: 22.0 },
}

export interface TaskCost {
  cny: number               // 计算出的成本（元）
  tokens: number            // 计费 token 数
  rate: number              // 适用单价（元/百万 token）
  tier: 'pro' | 'fast'
  withVideo: boolean        // 输入是否含视频
  formula: string           // hover 展示的计算公式
}

// 抽取 token 用量。返回 prompt/completion/total（缺失为 0）。
function extractUsage(task: TaskRow): { prompt: number; completion: number; total: number } {
  const r: any = task.response_payload
  const read = (u: any) => ({
    prompt: Number(u?.prompt_tokens) || 0,
    completion: Number(u?.completion_tokens) || 0,
    total: Number(u?.total_tokens) || 0,
  })
  if (!r || typeof r !== 'object') return { prompt: 0, completion: 0, total: 0 }
  const polls = Array.isArray(r.polls) ? r.polls : []
  for (let i = polls.length - 1; i >= 0; i--) {
    if (polls[i]?.usage) return read(polls[i].usage)
  }
  if (r.usage) return read(r.usage)
  // chat completions 同步响应直接在顶层
  if (r.choices && r.usage) return read(r.usage)
  return { prompt: 0, completion: 0, total: 0 }
}

function extractTokens(task: TaskRow): number {
  const u = extractUsage(task)
  return u.total || u.completion || 0
}

// 计算任务成本。
// - per_mtoken_video（Seedance）：按"输入是否含视频"取两档单价 × total_tokens；
//   单价来自任务快照(price_novideo_cny/price_video_cny)，缺失时回退旧常量。
// - 其他模型：用任务自身的价格快照（task.price_*，下单时冻结），按次或按量拆分。
//   不再依赖 live 模型定价——模型改价不影响历史任务成本。
//   兼容旧签名：仍接受 model 参数，但仅当任务快照缺失时回退使用。
export function computeTaskCost(task: TaskRow | null, model?: Model | null): TaskCost | null {
  if (!task || task.status !== 'succeeded') return null

  // Seedance 两档（含/不含视频）按量计价。优先用任务快照价；快照缺失（老任务）
  // 时回退到旧常量，按模型名推断 Pro/Fast 档位。
  const priceModeEff = task.price_mode ?? model?.price_mode ?? null
  if (priceModeEff === 'per_mtoken_video' || (priceModeEff == null && task.api_format === 'doubao-video')) {
    const tokens = extractTokens(task)
    if (!tokens) return null
    const name = `${task.model_name || ''}`.toLowerCase()
    const tier: 'pro' | 'fast' = name.includes('fast') ? 'fast' : 'pro'
    const withVideo = !!task.refs?.video?.length
    const snapNoVideo = task.price_novideo_cny ?? model?.price_novideo_cny ?? null
    const snapVideo = task.price_video_cny ?? model?.price_video_cny ?? null
    const rate = withVideo
      ? (snapVideo ?? SEEDANCE_RATES[tier].withVideo)
      : (snapNoVideo ?? SEEDANCE_RATES[tier].noVideo)
    const cny = (tokens / 1_000_000) * rate
    const formula = `${tokens.toLocaleString()} token ÷ 1,000,000 × ${rate.toFixed(2)} 元/百万token`
      + `（${withVideo ? '含视频输入' : '不含视频输入'}）`
      + ` = ¥${cny.toFixed(4)}`
    return { cny, tokens, rate, tier, withVideo, formula }
  }

  // 其他模型：优先用任务的价格快照，回退到传入的 live model（兼容旧调用）。
  const priceMode = task.price_mode ?? model?.price_mode ?? null
  const priceCny = task.price_cny ?? model?.price_cny ?? null
  const priceInCny = task.price_in_cny ?? model?.price_in_cny ?? null
  const priceOutCny = task.price_out_cny ?? model?.price_out_cny ?? null
  if (!priceMode) return null
  if (priceMode === 'per_call' && priceCny != null) {
    return {
      cny: priceCny, tokens: 0, rate: priceCny, tier: 'pro', withVideo: false,
      formula: `按次计费 ¥${priceCny}/次`,
    }
  }
  if (priceMode === 'per_mtoken') {
    const u = extractUsage(task)
    const inRate = priceInCny ?? 0
    const outRate = priceOutCny ?? 0
    if (!u.prompt && !u.completion && !u.total) return null
    const inCost = (u.prompt / 1_000_000) * inRate
    const outCost = (u.completion / 1_000_000) * outRate
    const cny = inCost + outCost
    const formula = `提示 ${u.prompt.toLocaleString()} × ¥${inRate}/M`
      + ` + 补全 ${u.completion.toLocaleString()} × ¥${outRate}/M = ¥${cny.toFixed(4)}`
    return { cny, tokens: u.total || (u.prompt + u.completion), rate: inRate, tier: 'pro', withVideo: false, formula }
  }
  return null
}

export function formatCost(cny: number): string {
  return `¥${cny < 0.01 ? cny.toFixed(4) : cny.toFixed(2)}`
}
