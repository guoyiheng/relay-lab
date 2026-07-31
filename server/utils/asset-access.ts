import { useDb } from './db'
import { keyFromUrl } from './storage'

// 只允许当前用户访问自己的素材对象，或自己任务结果中精确记录过的远端 URL。
export async function userOwnsAssetUrl(userId: number, url: string): Promise<boolean> {
  const db = useDb()
  const r2Key = keyFromUrl(url)
  if (r2Key) {
    const owned = await db.prepare('SELECT 1 FROM assets WHERE user_id = ? AND r2_key = ? LIMIT 1').get(userId, r2Key)
    if (owned) return true
  }

  const result = await db.prepare(`
    SELECT 1
      FROM tasks t,
           json_each(CASE WHEN json_valid(t.result_urls) THEN t.result_urls ELSE '[]' END) result
     WHERE t.user_id = ?
       AND t.deleted_at IS NULL
       AND result.value = ?
     LIMIT 1
  `).get(userId, url)
  return !!result
}
