import { describe, expect, it } from 'vitest'
import { normalizeProviderUrl } from '../shared/provider-url'

describe('normalizeProviderUrl', () => {
  it('removes trailing slashes from a Base URL', () => {
    expect(normalizeProviderUrl(' https://api.example.com/v1/// ', 'openai-sync'))
      .toBe('https://api.example.com/v1')
  })

  it('preserves a complete URL path, query, and trailing slash', () => {
    expect(normalizeProviderUrl(' https://api.example.com/generate/?channel=relay ', 'full-url'))
      .toBe('https://api.example.com/generate/?channel=relay')
  })
})
