/**
 * Prompt favorites — saved prompt snippets, persisted in localStorage.
 * Triggered from the 概览 tab (收藏 button) and recalled in the prompt box
 * by typing "/". Newest first, deduped by text.
 */
const LS_KEY = 'relay.promptFavorites.v1'

export interface PromptFavorite {
  id: string
  text: string
  created_at: number
}

const favorites = ref<PromptFavorite[]>([])
let loaded = false

function load() {
  if (loaded || typeof localStorage === 'undefined') return
  favorites.value = readArray<PromptFavorite>(LS_KEY)
  loaded = true
}

function persist() {
  writeStore(LS_KEY, favorites.value)
}

export function usePromptFavorites() {
  load()

  function add(text: string): boolean {
    const t = text.trim()
    if (!t) return false
    if (favorites.value.some((f) => f.text === t)) return false // dedupe
    favorites.value = [
      { id: `fav_${Date.now().toString(36)}`, text: t, created_at: Date.now() },
      ...favorites.value,
    ]
    persist()
    return true
  }

  function remove(id: string) {
    favorites.value = favorites.value.filter((f) => f.id !== id)
    persist()
  }

  function has(text: string): boolean {
    return favorites.value.some((f) => f.text === text.trim())
  }

  return { favorites, add, remove, has }
}
