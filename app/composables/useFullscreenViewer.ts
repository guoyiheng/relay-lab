/**
 * Shared fullscreen media viewer state. A single overlay (mounted once in the
 * default layout) is driven by this composable so any component — ResultViewer,
 * TaskDetail overview refs, asset picker — can open fullscreen without each
 * re-implementing the overlay.
 */
interface FullscreenState {
  url: string | null
  kind: 'image' | 'video' | 'audio'
}

const state = reactive<FullscreenState>({ url: null, kind: 'image' })

export function useFullscreenViewer() {
  function open(url: string, kind: 'image' | 'video' | 'audio' = 'image') {
    state.url = url
    state.kind = kind
  }
  function close() {
    state.url = null
  }
  return { state, open, close }
}
