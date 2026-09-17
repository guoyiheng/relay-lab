import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { ProviderRecord } from '../server/utils/db'

describe('deleteArkAsset', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('throws when provider has no ark credentials', async () => {
    const { deleteArkAsset } = await import('../server/utils/seedance-assets')
    const fakeProvider: ProviderRecord = {
      id: 1,
      name: 'Test',
      user_id: 'user1',
      base_url: 'https://api.example.com',
      api_key: 'key',
      adapter: 'doubao-video',
      concurrency_limit: 1,
      timeout_secs: 60,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
      ark_access_key: null,
      ark_secret_key: null,
    }

    await expect(deleteArkAsset(fakeProvider, 'asset-123')).rejects.toThrow('该平台未配置素材库 AK/SK')
  })

  it('succeeds when upstream returns NotFound (idempotent)', async () => {
    const { deleteArkAsset } = await import('../server/utils/seedance-assets')
    const fakeProvider: ProviderRecord = {
      id: 1,
      name: 'Test',
      user_id: 'user1',
      base_url: 'https://api.example.com',
      api_key: 'key',
      adapter: 'doubao-video',
      concurrency_limit: 1,
      timeout_secs: 60,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
      ark_access_key: 'test-ak',
      ark_secret_key: 'test-sk',
      ark_region: 'cn-beijing',
      ark_project_name: 'default',
    }

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ResponseMetadata: {
            RequestId: 'req-123',
            Action: 'DeleteAsset',
            Version: '2024-01-01',
            Service: 'ark',
            Region: 'cn-beijing',
            Error: {
              Code: 'NotFound.asset_id',
              Message: 'The specified asset asset-123 is not found.',
            },
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    )

    const result = await deleteArkAsset(fakeProvider, 'asset-123')
    expect(result).toBe(true)
  })

  it('succeeds when upstream returns Success', async () => {
    const { deleteArkAsset } = await import('../server/utils/seedance-assets')
    const fakeProvider: ProviderRecord = {
      id: 1,
      name: 'Test',
      user_id: 'user1',
      base_url: 'https://api.example.com',
      api_key: 'key',
      adapter: 'doubao-video',
      concurrency_limit: 1,
      timeout_secs: 60,
      enabled: 1,
      created_at: 0,
      updated_at: 0,
      ark_access_key: 'test-ak',
      ark_secret_key: 'test-sk',
      ark_region: 'cn-beijing',
      ark_project_name: 'default',
    }

    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async (input, init) => {
      expect(init?.method).toBe('POST')
      const body = JSON.parse(init?.body as string)
      expect(body.Id).toBe('asset-valid')
      expect(body.ProjectName).toBe('default')
      expect(String(input)).toContain('Action=DeleteAsset')

      return new Response(
        JSON.stringify({
          ResponseMetadata: {
            RequestId: 'req-456',
            Action: 'DeleteAsset',
            Version: '2024-01-01',
            Service: 'ark',
            Region: 'cn-beijing',
          },
          Result: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })

    const result = await deleteArkAsset(fakeProvider, 'asset-valid')
    expect(result).toBe(true)
  })
})
