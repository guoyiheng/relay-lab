export interface DetectedTrigger {
  type: 'asset' | 'fav'
  query: string
  /**
   * Length of the trigger token to replace (including trigger character like @ or /).
   * E.g. for "/cat", tokenLen is 4 (1 for "/" + 3 for "cat").
   */
  tokenLen: number
}

// Punctuation and whitespace characters that terminate a trigger query.
// Includes CJK punctuation, English punctuation, and whitespace.
// Note: '.' is allowed in queries to support file extensions (e.g. @demo.mp4) or version numbers (e.g. /v1.0).
export const TRIGGER_STOP_CHARS = "\\s@/，。！？；：“”‘’（）《》【】、〈〉——……,!?;:\"'()\\[\\]{}~`|#"

// Slash trigger (favorites):
// Must be at the start of string/line OR immediately preceded by whitespace/newline.
// It will NEVER match inside URLs (http://), ratios (16/9), words (a/b), or Chinese text (不行……/不要……).
export const FAV_TRIGGER_RE = new RegExp(`(?:^|[\\s\\r\\n])\\/([^${TRIGGER_STOP_CHARS}]{0,30})$`)

// At trigger (assets):
// Must be at string start OR preceded by non-alphanumeric character (prevents matching emails like user@example.com).
export const ASSET_TRIGGER_RE = new RegExp(`(?:^|[^a-zA-Z0-9_.-])@([^${TRIGGER_STOP_CHARS}]{0,30})$`)

export function detectTriggerToken(upto: string, allowAssets = true): DetectedTrigger | null {
  // 1. Check slash trigger (/) for favorite prompts
  const favMatch = upto.match(FAV_TRIGGER_RE)
  if (favMatch) {
    const query = favMatch[1] ?? ''
    return {
      type: 'fav',
      query,
      tokenLen: query.length + 1,
    }
  }

  // 2. Check at trigger (@) for reference assets
  if (allowAssets) {
    const assetMatch = upto.match(ASSET_TRIGGER_RE)
    if (assetMatch) {
      const query = assetMatch[1] ?? ''
      return {
        type: 'asset',
        query,
        tokenLen: query.length + 1,
      }
    }
  }

  return null
}
