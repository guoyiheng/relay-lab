/** Seed Audio 参数表单（平铺字段）和请求 JSON 共用同一转换规则。 */
export function seedAudioParams(params: Record<string, unknown>): Record<string, unknown> {
  const nested = params.audio_config
  const config = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown> : {}
  const references = Array.isArray(params.references) ? params.references : []
  const speakerRef = references.find((r) => r && typeof r === 'object' && typeof r.speaker === 'string')
  return { ...config, ...params, speaker: params.speaker ?? speakerRef?.speaker }
}

export function seedAudioConfig(params: Record<string, unknown>): Record<string, unknown> {
  const p = seedAudioParams(params)
  const format = ['wav', 'mp3', 'pcm', 'ogg_opus'].includes(String(p.format)) ? String(p.format) : 'mp3'
  const rates = format === 'ogg_opus' ? [48000]
    : format === 'mp3' ? [8000, 16000, 24000, 32000, 44100, 48000]
      : [8000, 16000, 24000, 32000, 40000, 44100, 48000]
  const defaultRate = format === 'mp3' || format === 'ogg_opus' ? 48000 : 40000
  const result: Record<string, unknown> = {
    format,
    sample_rate: rates.includes(Number(p.sample_rate)) ? Number(p.sample_rate) : defaultRate,
    pitch_rate: Number(p.pitch_rate ?? 0),
    speech_rate: Number(p.speech_rate ?? 0),
    loudness_rate: Number(p.loudness_rate ?? 0),
  }
  if (p.enable_subtitle !== undefined) result.enable_subtitle = !!p.enable_subtitle
  return result
}
