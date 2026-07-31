import { cfEnv } from '~~/server/utils/db'

export default defineEventHandler(() => {
  const metadata = cfEnv().CF_VERSION_METADATA
  return { version_id: metadata?.id?.slice(0, 8) || '' }
})
