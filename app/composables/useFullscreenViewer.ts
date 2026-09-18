/**
 * Shared fullscreen media viewer state. A single overlay (mounted once in the
 * default layout) is driven by this composable so any component — ResultViewer,
 * TaskDetail overview refs, asset picker — can open fullscreen without each
 * re-implementing the overlay.
 */
interface FullscreenState {
  url: string | null
  kind: 'image' | 'video' | 'audio'
  trimSeconds: number | null
  onTrim?: (seconds: number | null) => void
}

const state = reactive<FullscreenState>({ url: null, kind: 'image', trimSeconds: null })

export interface FullscreenOpenOptions {
  trimSeconds?: number | null
  onTrim?: (seconds: number | null) => void
}

export function useFullscreenViewer() {
  function open(url: string, kind: 'image' | 'video' | 'audio' = 'image', options: FullscreenOpenOptions = {}) {
    state.url = url
    state.kind = kind
    state.trimSeconds = options.trimSeconds ?? null
    state.onTrim = options.onTrim
  }
  function close() {
    state.url = null
    state.trimSeconds = null
    state.onTrim = undefined
  }
  return { state, open, close }
}
