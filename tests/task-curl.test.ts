import { describe, expect, it } from 'vitest'
import { shellSingleQuote, taskEndpoint, type TaskEndpointInput } from '../shared/task-curl'

const endpoint = (task: TaskEndpointInput) => taskEndpoint(task, 'https://api.example.com/v1/')?.url

describe('taskEndpoint', () => {
  it.each([
    [{ kind: 'text', api_format: 'openai-sync' }, 'https://api.example.com/v1/chat/completions'],
    [{ kind: 'image', api_format: 'openai-sync' }, 'https://api.example.com/v1/images/generations'],
    [{ kind: 'video', api_format: 'openai-sync' }, 'https://api.example.com/v1/videos/generations'],
    [{ kind: 'image', api_format: 'openai-async' }, 'https://api.example.com/v1/images/generations?async=true'],
    [{ kind: 'video', api_format: 'doubao-video' }, 'https://api.example.com/v1/contents/generations/tasks'],
    [{ kind: 'image', api_format: 'xai-image' }, 'https://api.example.com/v1/images/generations'],
    [{ kind: 'image', api_format: 'xai-image', request_payload: { image: 'data:...' } }, 'https://api.example.com/v1/images/edits'],
    [{ kind: 'image', api_format: 'xai-image', request_payload: { images: [] } }, 'https://api.example.com/v1/images/edits'],
    [{ kind: 'image', api_format: 'full-url' }, 'https://api.example.com/v1/'],
  ] satisfies Array<[TaskEndpointInput, string]>)('maps %o to %s', (task, expected) => {
    expect(endpoint(task)).toBe(expected)
  })

  it('returns null without a base URL', () => {
    expect(taskEndpoint({ kind: 'image', api_format: 'openai-sync' }, '')).toBeNull()
  })

  it('preserves a complete URL exactly', () => {
    const fullUrl = 'https://api.example.com/generate/?channel=relay'
    expect(taskEndpoint({ kind: 'video', api_format: 'full-url' }, fullUrl)?.url).toBe(fullUrl)
  })
})

describe('shellSingleQuote', () => {
  it('escapes embedded single quotes for POSIX shells', () => {
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'")
  })
})
