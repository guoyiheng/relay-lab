import { describe, expect, it } from 'vitest'
import { seedAudioOverviewParams } from '../shared/seed-audio'

describe('audio overview parameters', () => {
  it('includes defaults even when no form fields were changed', () => {
    expect(seedAudioOverviewParams({}, null)).toEqual({
      format: 'mp3', sample_rate: 48000, pitch_rate: 0, speech_rate: 0, loudness_rate: 0,
      watermark: {},
    })
  })

  it('flattens the actual request and preserves zero, false, references and extra fields', () => {
    const request = {
      model: 'seed-audio', text_prompt: 'hello',
      audio_config: { format: 'wav', sample_rate: 40000, pitch_rate: 0, speech_rate: 0, loudness_rate: 0, enable_subtitle: false },
      references: [{ speaker: 'voice-1' }], watermark: {}, extra: { value: 1 },
    }
    expect(seedAudioOverviewParams({ format: 'mp3', sample_rate: 44100, speech_rate: 50 }, request)).toEqual({
      ...request.audio_config, references: request.references, watermark: {}, extra: { value: 1 },
    })
  })

  it('supports nested JSON parameters and normalizes invalid sample rates in list previews', () => {
    expect(seedAudioOverviewParams({
      audio_config: { format: 'ogg_opus', sample_rate: 8000, enable_subtitle: true },
      references: [{ speaker: ' voice-1 ' }],
    }, null)).toEqual({
      format: 'ogg_opus', sample_rate: 48000, pitch_rate: 0, speech_rate: 0, loudness_rate: 0,
      enable_subtitle: true, references: [{ speaker: 'voice-1' }], watermark: {},
    })
  })
})
