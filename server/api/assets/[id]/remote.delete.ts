import { getRouterParam, getQuery } from 'h3'
import { useDb, type AssetRecord, type ProviderRecord } from '~~/server/utils/db'
import { requireUserId } from '~~/server/utils/auth'
import { deleteArkAsset } from '~~/server/utils/seedance-assets'

export default defineEventHandler(async (event) => {
  const userId = requireUserId(event)
  if (event.method !== 'DELETE') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: '缺少素材 ID' })
  }

  const query = getQuery(event)
  const db = useDb()

  // 既支持本地素材 id（id/assetDbId），也支持远端 asset-id（seedance_asset_id）
  const asset = await db.prepare(`
    SELECT * FROM assets WHERE user_id = ? AND (id = ? OR seedance_asset_id = ?)
  `).get(userId, id, id) as AssetRecord | null

  const remoteAssetId = asset?.seedance_asset_id || (id.startsWith('asset-') ? id : null)

  if (!remoteAssetId) {
    if (asset) {
      await db.prepare('UPDATE assets SET seedance_asset_id = NULL WHERE id = ? AND user_id = ?').run(asset.id, userId)
    }
    return { ok: true, remote_asset_id: null, message: '素材未关联远端素材 ID' }
  }

  // 查找对应具备素材库凭证的平台
  let provider: ProviderRecord | null = null
  if (query.provider_id) {
    provider = await db.prepare('SELECT * FROM providers WHERE id = ? AND user_id = ?')
      .get(Number(query.provider_id), userId) as ProviderRecord | null
  }
  if (!provider && query.task_id) {
    provider = await db.prepare(`
      SELECT p.* FROM tasks t JOIN providers p ON p.id = t.provider_id WHERE t.id = ? AND t.user_id = ?
    `).get(Number(query.task_id), userId) as ProviderRecord | null
  }
  if (!provider) {
    provider = await db.prepare(`
      SELECT * FROM providers
      WHERE user_id = ? AND enabled = 1 AND ark_access_key IS NOT NULL AND ark_access_key != ''
      ORDER BY id ASC LIMIT 1
    `).get(userId) as ProviderRecord | null
  }

  if (!provider) {
    throw createError({ statusCode: 400, statusMessage: '未找到配置了素材库 AK/SK 的平台，无法连接远端删除' })
  }

  // 从火山方舟虚拟人像库删除
  await deleteArkAsset(provider, remoteAssetId)

  // 清空数据库中的关联缓存，不触碰 R2 与本地素材行
  await db.prepare(`
    UPDATE assets SET seedance_asset_id = NULL WHERE user_id = ? AND (id = ? OR seedance_asset_id = ?)
  `).run(userId, id, remoteAssetId)

  return {
    ok: true,
    remote_asset_id: remoteAssetId,
    message: '远端素材已成功删除',
  }
})
