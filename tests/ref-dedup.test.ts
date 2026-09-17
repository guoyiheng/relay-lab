import { describe, expect, it } from 'vitest'
import { canonicalRefSig, getRefTokens, isSameRef } from '../app/composables/useRefUpload'

describe('Reference asset deduplication', () => {
  it('identifies identical direct URLs as duplicate', () => {
    const a = { public_url: 'https://cdn.example.com/images/cat.png' }
    const b = { url: 'https://cdn.example.com/images/cat.png' }
    expect(isSameRef(a, b)).toBe(true)
  })

  it('identifies identical blob URLs as duplicate', () => {
    const a = { public_url: 'blob:http://localhost:3000/1234-5678', sig: 'file:cat.png|1000|1600000000' }
    const b = { url: 'blob:http://localhost:3000/1234-5678', id: 'file:cat.png|1000|1600000000' }
    expect(isSameRef(a, b)).toBe(true)
  })

  it('identifies local file upload matched with @-picked selected asset', () => {
    // Local uploaded item in reference strip
    const localRef = {
      id: '',
      kind: 'image' as const,
      filename: 'avatar.png',
      public_url: 'blob:http://localhost:3000/uuid-blob',
      sig: 'file:avatar.png|2048|1700000000',
    }

    // Selected asset constructed in PromptEditor from mentionedRefs
    const pickedFromPopover = {
      id: 'file:avatar.png|2048|1700000000',
      kind: 'image' as const,
      url: 'blob:http://localhost:3000/uuid-blob',
      filename: 'avatar.png',
      source: 'generated',
    }

    expect(isSameRef(localRef, pickedFromPopover)).toBe(true)
  })

  it('identifies generated asset dragged from task with same asset from library', () => {
    // Dragged from task row into strip
    const draggedItem = {
      id: '',
      public_url: 'https://r2.myhost.com/results/123/res_0.png',
      sig: 'url:https://r2.myhost.com/results/123/res_0.png',
    }

    // Picked via @ from library (has DB asset id)
    const libraryAsset = {
      id: 'ast_456789',
      url: 'https://r2.myhost.com/results/123/res_0.png',
      source: 'generated',
    }

    expect(isSameRef(draggedItem, libraryAsset)).toBe(true)
  })

  it('identifies database asset id equality with or without id: prefix', () => {
    const a = { id: 'ast_123', sig: 'id:ast_123' }
    const b = { id: 'id:ast_123' }
    expect(isSameRef(a, b)).toBe(true)
  })

  it('identifies upload URL id extraction', () => {
    const a = { public_url: 'http://localhost:3000/api/uploads/ast_999' }
    const b = { id: 'ast_999' }
    expect(isSameRef(a, b)).toBe(true)
  })

  it('distinguishes different assets as NOT duplicates', () => {
    const a = { id: 'ast_1', public_url: 'https://cdn.example.com/1.png' }
    const b = { id: 'ast_2', public_url: 'https://cdn.example.com/2.png' }
    expect(isSameRef(a, b)).toBe(false)
  })

  it('generates proper canonical signatures', () => {
    expect(canonicalRefSig({ id: 'ast_1' })).toBe('id:ast_1')
    expect(canonicalRefSig({ id: 'id:ast_1' })).toBe('id:ast_1')
    expect(canonicalRefSig({ url: 'https://cdn.example.com/1.png' })).toBe('url:https://cdn.example.com/1.png')
    expect(canonicalRefSig({ sig: 'file:cat.png|100|200' })).toBe('file:cat.png|100|200')
  })

  it('extracts tokens comprehensively', () => {
    const tokens = getRefTokens({
      id: 'ast_100',
      public_url: 'https://cdn.example.com/uploads/ast_100',
    })
    expect(tokens).toContain('ast_100')
    expect(tokens).toContain('id:ast_100')
    expect(tokens).toContain('https://cdn.example.com/uploads/ast_100')
  })
})
