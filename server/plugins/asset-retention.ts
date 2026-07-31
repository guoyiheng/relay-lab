import { cleanupExpiredAssets } from '~~/server/utils/asset-retention'

// Cloudflare Cron Trigger: regularly remove expired R2 media while preserving
// task rows. Awaiting the hook keeps the scheduled event alive until cleanup
// completes; batches are deliberately bounded in cleanupExpiredAssets().
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:scheduled', async ({ controller }: { controller: ScheduledController }) => {
    try {
      const result = await cleanupExpiredAssets()
      console.info(JSON.stringify({ event: 'asset_retention_cleanup', cron: controller.cron, ...result }))
    } catch (error) {
      console.error('[asset-retention] scheduled cleanup failed:', error)
      throw error
    }
  })
})
