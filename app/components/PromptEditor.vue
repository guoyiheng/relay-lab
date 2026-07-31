<script setup lang="ts">
// 富文本提示词编辑器：支持 @ 引用素材（生成 chip）、收藏提示词、素材选择器。
// 对外以 PromptSegment[] 结构双向绑定，把纯文本与素材引用统一表达。
import type { PickerAsset, PromptSegment } from '~~/types/api'
import { usePromptFavorites } from '~/composables/usePromptFavorites'

interface RefChip {
  id: string
  kind: 'image' | 'video' | 'audio'
  filename: string | null
  public_url: string
  sig?: string
}

const props = defineProps<{
  modelValue: string
  // Which asset kinds the current model accepts (for @ filtering). Empty = none.
  allowKinds: ('image' | 'video' | 'audio')[]
  // Kept for backwards-compat with the parent binding; chips are now inline so
  // this is no longer rendered as a separate row.
  mentionedRefs?: RefChip[]
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'update:segments', v: PromptSegment[]): void
  (e: 'submit'): void
  (e: 'pick-asset', asset: PickerAsset): void
}>()

const editor = ref<HTMLDivElement | null>(null)
const rootRef = ref<HTMLDivElement | null>(null)
const popoverRef = ref<HTMLDivElement | null>(null)
const focused = ref(false)
const enlarged = ref(false)  // Tab toggles a taller editor; Esc / blur resets
// IME composition guard — true while the user is composing CJK characters.
// During composition, we must NOT sync to the model or intercept keys,
// otherwise the input method is interrupted (first char lost / can't confirm).
const isComposing = ref(false)
const isEmpty = ref(true)
const MAX_CHARS = 2000
const charCount = computed(() => props.modelValue?.length || 0)
const overLimit = computed(() => charCount.value > MAX_CHARS)
// SSR renders the collapsed state; we only expand after mount so the server
// markup and the first client render match (avoids hydration mismatch).
const mounted = ref(false)
// The last text we emitted — guards the modelValue watcher against echoing our
// own update back into the DOM (which would wipe chips + reset the caret).
let lastEmitted = ''
// ── trigger state ─────────────────────────────────────────────
type Trigger = null | 'asset' | 'fav'
const trigger = ref<Trigger>(null)
const query = ref('')
const activeIndex = ref(0)
// DOM anchor of the active @// token so we can replace exactly those chars.
let triggerNode: Text | null = null
let triggerStartOffset = -1
let triggerEndOffset = -1
// Sigs of chips the user deleted from the prompt (Backspace). The material stays
// selected in the reference strip / @ list — only its inline mention is dropped.
// reconcileChips consults this so a later strip edit (reorder / add) never
// resurrects a dismissed chip. Cleared for a sig only when the user re-@-mentions
// that asset, or when the material actually leaves the strip.
const dismissedTokens = ref<Set<string>>(new Set())

const { favorites } = usePromptFavorites()

// Asset list (lazy-loaded once when @ first fires)
const assets = ref<PickerAsset[]>([])
const assetsLoaded = ref(false)
const loadingAssets = ref(false)
// Bumped whenever new data lands (or the popover reopens) so the list wrapper's
// :key changes → Vue destroys & rebuilds the rows from scratch (item 1: avoids
// stale/blank thumbnails carried over from a previous render).
const listVersion = ref(0)
async function ensureAssets() {
  if (assetsLoaded.value || loadingAssets.value) return
  loadingAssets.value = true
  try {
    assets.value = await useDataSource().listAssets()
    assetsLoaded.value = true
    listVersion.value++
  } finally {
    loadingAssets.value = false
  }
}



const PAGE = 20
const visibleCount = ref(PAGE)

const filteredAssets = computed(() => {
  const q = query.value.toLowerCase()
  return assets.value
    .filter((a) => {
      if (props.allowKinds.length && !props.allowKinds.includes(a.kind)) return false
      if (!q) return true
      return (a.filename || '').toLowerCase().includes(q)
        || String(a.meta?.task_id || '').includes(q)
        || (a.meta?.prompt || '').toLowerCase().includes(q)
    })
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0)) // newest first
})

// Delete an asset from the library directly inside the @ popover.
async function deleteAsset(a: PickerAsset, e: MouseEvent) {
  e.stopPropagation()
  assets.value = assets.value.filter((x) => x.id !== a.id)
  try {
    if (a.source === 'upload') {
      await useDataSource().deleteAsset(a.id)
    } else if (a.meta?.task_id != null) {
      const idx = Number(a.id.split(':').pop())
      await useDataSource().deleteTaskResult(a.meta.task_id, idx)
      // Deleting a generated result may cascade-remove the task's orphan
      // reference uploads — re-fetch so the list reflects the server state.
      assetsLoaded.value = false
      await ensureAssets()
    }
  } catch { /* keep optimistic removal */ }
}

const filteredFavorites = computed(() => {
  const q = query.value.toLowerCase()
  if (!q) return favorites.value
  return favorites.value.filter((f) => f.text.toLowerCase().includes(q))
})

const visibleAssets = computed(() => filteredAssets.value.slice(0, visibleCount.value))
const visibleFavorites = computed(() => filteredFavorites.value.slice(0, visibleCount.value))

// Signatures of refs already added to the prompt, so the @ list can surface a
// "已选" group at the top — and so library rows for already-picked assets are
// filtered out (dedup). Matching is robust across id/url/sig forms because a
// generated asset's library identity (url:<resultUrl>) differs from its ref
// identity after import (id:<uploadId> + /uploads/ url); we collect every token
// each side could present and intersect them.
function refTokens(r: RefChip): string[] {
  const t: string[] = []
  if (r.sig) t.push(r.sig)
  if (r.id) t.push(`id:${r.id}`)
  if (r.public_url) {
    t.push(`url:${r.public_url}`)
    const m = r.public_url.match(/\/uploads\/([^/?#]+)/)
    if (m) t.push(`id:${m[1]}`)
  }
  return t
}
function assetTokens(a: PickerAsset): string[] {
  const t: string[] = [assetSig(a)]
  if (a.id) t.push(`id:${a.id}`)
  if (a.url) {
    t.push(`url:${a.url}`)
    const m = a.url.match(/\/uploads\/([^/?#]+)/)
    if (m) t.push(`id:${m[1]}`)
  }
  return t
}
const selectedSigs = computed(() => {
  const s = new Set<string>()
  for (const r of (props.mentionedRefs || [])) for (const tok of refTokens(r as RefChip)) s.add(tok)
  return s
})
function isSelected(a: PickerAsset): boolean {
  return assetTokens(a).some((tok) => selectedSigs.value.has(tok))
}
// 已选 group is built from the CURRENT refs (mentionedRefs) — this includes
// local pending uploads that aren't in /api/assets yet (item 5). Each chip is
// adapted to the PickerAsset shape the list rows expect.
const selectedAssets = computed<PickerAsset[]>(() => {
  const q = query.value.toLowerCase()
  return (props.mentionedRefs || [])
    .filter((r) => !props.allowKinds.length || props.allowKinds.includes(r.kind))
    .map((r) => {
      const rc = r as RefChip
      const sig = refSig(rc)
      return {
        source: rc.id ? 'upload' : 'generated',
        id: rc.id || sig,
        kind: rc.kind,
        url: rc.public_url,
        filename: rc.filename,
        mime: null, size: null, width: null, height: null,
        created_at: 0,
      } as PickerAsset
    })
    .filter((a) => !q || (a.filename || '').toLowerCase().includes(q))
})
// 两个分组：顶部「已选参考」= 当前引用的素材（含本地刚选、尚未上传的），
// 底部「所有素材」= 完整素材库（按 allowKinds/query 过滤 + 分页）。已在两处
// 出现的库素材在底部带勾选标记；本地未上传素材只出现在顶部。
// Flat ordered list (selected first, then library) for keyboard nav indexing —
// MUST match the assetRows render order below.
const orderedAssets = computed(() => [...selectedAssets.value, ...visibleAssets.value])

// Flat render rows: group headers + asset rows in ONE list. Rendering both
// groups through a single v-for (rather than two) keeps each row's DOM node —
// crucially the <img> — mounted, avoiding a blank thumbnail flash on reopen.
// Keys are group-prefixed so a selected library asset can appear in both the
// 已选 and 所有 groups without a duplicate :key.
type AssetRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'asset'; key: string; asset: PickerAsset; selected: boolean; navIndex: number }
const assetRows = computed<AssetRow[]>(() => {
  const rows: AssetRow[] = []
  const sel = selectedAssets.value
  const all = visibleAssets.value
  let nav = 0
  if (sel.length) {
    rows.push({ kind: 'header', key: 'h-sel', label: `已选参考 · ${sel.length}` })
    for (const a of sel) rows.push({ kind: 'asset', key: `sel:${assetSig(a)}`, asset: a, selected: true, navIndex: nav++ })
  }
  if (all.length) {
    rows.push({ kind: 'header', key: 'h-all', label: `所有素材 · ${all.length}` })
    for (const a of all) rows.push({ kind: 'asset', key: `all:${assetSig(a)}`, asset: a, selected: isSelected(a), navIndex: nav++ })
  }
  return rows
})

const showPopover = computed(() => trigger.value !== null)
const popoverEmpty = computed(() =>
  trigger.value === 'asset' ? (selectedAssets.value.length + visibleAssets.value.length) === 0
    : trigger.value === 'fav' ? filteredFavorites.value.length === 0
      : true,
)



function kindLabel(k: string) {
  return ({ image: '图', video: '视', audio: '音' } as Record<string, string>)[k] || k
}

function assetSig(a: PickerAsset): string {
  return a.source === 'upload' ? `id:${a.id}` : `url:${a.url}`
}
// Signature of a current ref chip (mirrors index.vue's refSig).
function refSig(r: RefChip): string {
  return r.sig || (r.id ? `id:${r.id}` : `url:${r.public_url}`)
}

// ── DOM ↔ model serialization ─────────────────────────────────
// Walk the editable in document order: text nodes → text segments, chip spans
// → ref segments. <br> / block boundaries become "\n".
function serialize(): { text: string; segments: PromptSegment[] } {
  const el = editor.value
  const segments: PromptSegment[] = []
  let text = ''
  if (!el) return { text, segments }

  const pushText = (t: string) => {
    if (!t) return
    const last = segments[segments.length - 1]
    if (last && last.type === 'text') last.text += t
    else segments.push({ type: 'text', text: t })
    text += t
  }

  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText((child as Text).data)
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const elc = child as HTMLElement
        if (elc.dataset && elc.dataset.refSig) {
          const sig = elc.dataset.refSig
          const kind = (elc.dataset.refKind || 'image') as 'image' | 'video' | 'audio'
          segments.push({ type: 'ref', sig, kind })
          // Mirror the chip into the readable text as its 「图片N」 label.
          text += elc.dataset.refLabel || ''
        } else if (elc.tagName === 'BR') {
          pushText('\n')
        } else if (elc.classList.contains('pe-overflow')) {
          // Overflow highlight wrapper — transparent, just recurse its text.
          walk(elc)
        } else {
          // Block element (browser may wrap lines in <div>): prefix newline.
          if (text && !text.endsWith('\n')) pushText('\n')
          walk(elc)
        }
      }
    }
  }
  walk(el)
  return { text, segments }
}


// Renumber chips by the REFERENCE STRIP order (per kind), so 图片1 = the first
// image in 参考素材, and drag-reordering the strip relabels chips here too.
// Falls back to document order for any chip whose sig isn't in the strip.
function refIndexBySig(): Map<string, number> {
  const map = new Map<string, number>()
  const counters: Record<RefChip['kind'], number> = { image: 0, video: 0, audio: 0 }
  for (const r of (props.mentionedRefs || [])) {
    const rc = r as RefChip
    counters[rc.kind] += 1
    // 注册该 ref 的所有 token（id:/url:/sig），让 chip 无论以哪种 sig 出现都能
    // 命中其在参考素材条中的序号 → 拖拽排序时 chip 的 图片N 一起重排。
    for (const tok of refTokens(rc)) if (!map.has(tok)) map.set(tok, counters[rc.kind])
  }
  return map
}
// Keep the inline chips reconciled with the reference strip (mentionedRefs):
//  - a ref removed from the strip → drop every chip carrying its sig（删除一起删除）
//  - a ref added via the strip (upload / drag / paste) that has no chip yet →
//    append one at the end（新增的素材同步进输入框）
// @-mention already inserts its chip synchronously before this runs, so it's
// found present and not duplicated. Reorder keeps the same sigs → no add/remove,
// only renumberChips relabels 图片N by strip order（拖拽排序一起排序）。
// Tokens a chip's sig could present, so it can be matched to a ref robustly
// (mirrors refTokens on the ref side): a generated asset's chip sig is url:…
// while its ref sig is id:…, so exact equality would miss — intersect tokens.
function sigTokens(sig: string): string[] {
  const t = [sig]
  if (sig.startsWith('id:')) return t
  if (sig.startsWith('url:')) {
    const m = sig.match(/\/uploads\/([^/?#]+)/)
    if (m) t.push(`id:${m[1]}`)
  }
  return t
}

function reconcileChips() {
  const el = editor.value
  if (!el) return
  const refs = (props.mentionedRefs || []) as RefChip[]
  const allRefTokens = new Set<string>()
  for (const r of refs) for (const tok of refTokens(r)) allRefTokens.add(tok)
  // 素材已从列表移除 → 删掉不再对应任何 ref 的 chip。
  const liveChips: HTMLElement[] = []
  el.querySelectorAll<HTMLElement>('[data-ref-sig]').forEach((chip) => {
    const toks = sigTokens(chip.dataset.refSig || '')
    if (toks.some((tok) => allRefTokens.has(tok))) liveChips.push(chip)
    else chip.remove()
  })
  // 素材若真的离开了素材条，其「被删 chip」记录也随之作废——下次重新加入应能再补 chip。
  if (dismissedTokens.value.size) {
    for (const tok of [...dismissedTokens.value]) if (!allRefTokens.has(tok)) dismissedTokens.value.delete(tok)
  }
  // 列表新增（含拖入/粘贴/上传）→ 给还没有 chip 的 ref 末尾补一个；
  // 但用户在输入框里手动删掉的 chip 不再自动补回（永久不出现，除非重新 @ 引用）。
  for (const r of refs) {
    const rTokens = refTokens(r)
    if (rTokens.some((tok) => dismissedTokens.value.has(tok))) continue
    const rTokenSet = new Set(rTokens)
    const has = liveChips.some((chip) => sigTokens(chip.dataset.refSig || '').some((tok) => rTokenSet.has(tok)))
    if (!has) {
      const chip = buildChip(refSig(r), r.kind, r.public_url)
      el.appendChild(chip)
      liveChips.push(chip)
    }
  }
}

function renumberChips() {
  const el = editor.value
  if (!el) return
  const zh: Record<string, string> = { image: '图片', video: '视频', audio: '音频' }
  const idxMap = refIndexBySig()
  const fallback: Record<'image' | 'video' | 'audio', number> = { image: 0, video: 0, audio: 0 }
  const chips = el.querySelectorAll<HTMLElement>('[data-ref-sig]')
  chips.forEach((chip) => {
    const kind = (chip.dataset.refKind || 'image') as 'image' | 'video' | 'audio'
    const sig = chip.dataset.refSig || ''
    // 用 chip sig 的所有 token 去匹配 strip 序号（generated 的 chip sig=url:，
    // ref sig=id:，需 token 交集才命中）。
    let num: number | undefined
    for (const tok of sigTokens(sig)) { const n = idxMap.get(tok); if (n != null) { num = n; break } }
    if (num == null) { fallback[kind] += 1; num = fallback[kind] }
    const plain = `${zh[kind] || kind}${num}`
    chip.dataset.refLabel = `「${plain}」`  // text mirror (with brackets)
    const lab = chip.querySelector('[data-chip-label]')
    if (lab) lab.textContent = plain          // visible chip (no brackets)
  })
}

// Recompute model from DOM and emit. Does NOT touch innerHTML (preserves caret).
function syncFromDom() {
  renumberChips()
  const { text, segments } = serialize()
  const hasChip = segments.some((s) => s.type === 'ref')
  // contenteditable leaves a stray <br>/<div> after deleting everything, which
  // serialises to "\n". If there's no chip and only whitespace, treat as empty.
  const normalized = (!hasChip && text.trim() === '') ? '' : text
  isEmpty.value = normalized.length === 0
  lastEmitted = normalized
  emit('update:modelValue', normalized)
  emit('update:segments', normalized === '' ? [] : segments)
}

// ── over-limit highlight ──────────────────────────────────────
// Wrap the >MAX_CHARS tail in a red span. Done live on input; the caret is
// saved as a character offset and restored after re-wrapping so typing isn't
// disrupted.
const OVERFLOW_CLASS = 'pe-overflow'
function clearOverflowMarks(): boolean {
  const el = editor.value
  if (!el) return false
  const marks = el.querySelectorAll(`span.${OVERFLOW_CLASS}`)
  if (marks.length === 0) return false
  marks.forEach((s) => {
    const parent = s.parentNode
    if (!parent) return
    while (s.firstChild) parent.insertBefore(s.firstChild, s)
    parent.removeChild(s)
    parent.normalize()
  })
  return true
}
// Caret position as a character offset where each chip counts as 1 unit and
// non-chip text counts by length. Counting chips as 1 (not 0) is critical:
// otherwise "before chip" and "after chip" map to the same offset, so restoring
// always lands before the chip → caret jumps to the front when deleting up to a
// chip. Chip-internal text is skipped (a chip is contentEditable=false).
function getCaretCharOffset(): number | null {
  const sel = window.getSelection()
  const el = editor.value
  if (!sel || sel.rangeCount === 0 || !el) return null
  const r = sel.getRangeAt(0)
  if (!el.contains(r.startContainer)) return null
  return measureOffset(el, r.startContainer, r.startOffset)
}
// Walk root in DOM order accumulating units (text=length, chip=1) until we hit
// the caret container; return the accumulated count at that point.
function measureOffset(root: HTMLElement, container: Node, containerOffset: number): number {
  let count = 0
  let done = -1
  const walk = (node: Node) => {
    if (done >= 0) return
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset?.refSig) {
      // A chip: caret can't be inside it. If the container IS the chip, stop.
      if (node === container) { done = count; return }
      count += 1
      return
    }
    if (node === container) {
      if (node.nodeType === Node.TEXT_NODE) { done = count + containerOffset; return }
      // Element container: count only children before containerOffset.
      const kids = Array.from(node.childNodes).slice(0, containerOffset)
      for (const k of kids) walk(k)
      done = count
      return
    }
    if (node.nodeType === Node.TEXT_NODE) { count += (node as Text).data.length; return }
    if (node.nodeType === Node.ELEMENT_NODE) {
      for (const c of Array.from(node.childNodes)) { if (done >= 0) break; walk(c) }
    }
  }
  for (const c of Array.from(root.childNodes)) { if (done >= 0) break; walk(c) }
  return done >= 0 ? done : count
}
function setCaretCharOffset(offset: number) {
  const el = editor.value
  if (!el) return
  let count = 0
  // Walk DOM order; text counts by length, chips count as 1 unit. Place the
  // caret inside a text node when the offset lands within it, else at the
  // element level immediately before/after a chip (a valid, visible position).
  const place = (parent: Node, nodes: Node[]): boolean => {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]
      if (!node) continue
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node as Text).data.length
        if (count + len >= offset) { placeCaret(node, offset - count); return true }
        count += len
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const elNode = node as HTMLElement
        if (elNode.dataset?.refSig) {
          // Before the chip.
          if (count >= offset) { placeCaret(parent, i); return true }
          count += 1
          // Exactly after the chip.
          if (count >= offset) { placeCaret(parent, i + 1); return true }
        } else {
          // Descend (e.g. overflow span wrapping text).
          if (place(elNode, Array.from(elNode.childNodes))) return true
        }
      }
    }
    return false
  }
  if (place(el, Array.from(el.childNodes))) return
  // offset past end → caret at very end
  placeCaret(el, el.childNodes.length)
}
function markOverflow(): boolean {
  const el = editor.value
  if (!el) return false
  const cleared = clearOverflowMarks()
  // Walk text nodes (skipping chip-internal text), wrap everything past
  // MAX_CHARS. Chips count as their label length toward the limit.
  let count = 0
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      // Skip into chip subtrees entirely (their text is the label, atomic).
      if (node.nodeType === Node.ELEMENT_NODE) {
        const e = node as HTMLElement
        if (e.dataset?.refSig) {
          count += (e.dataset.refLabel || '').length
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_SKIP
      }
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const toWrap: { node: Text; from: number }[] = []
  let n: Node | null
  while ((n = walker.nextNode())) {
    const t = n as Text
    const len = t.data.length
    if (count + len > MAX_CHARS) {
      const from = Math.max(0, MAX_CHARS - count)
      toWrap.push({ node: t, from })
    }
    count += len
  }
  if (toWrap.length === 0) return cleared
  
  for (const { node, from } of toWrap) {
    const tail = from > 0 ? node.splitText(from) : node
    const span = document.createElement('span')
    span.className = OVERFLOW_CLASS
    node.parentNode!.insertBefore(span, tail)
    span.appendChild(tail)
  }
  return true
}
// Re-apply overflow highlight live, preserving the caret.
function refreshOverflow() {
  const el = editor.value
  if (!el) return
  
  // Optimization: If we are far below the limit and have no existing marks,
  // we know the DOM won't be modified.
  if (el.textContent && el.textContent.length < MAX_CHARS && !el.querySelector('.' + OVERFLOW_CLASS)) {
    return
  }

  const caret = getCaretCharOffset()
  const changed = markOverflow()
  // CRITICAL: Only reset the native selection if we actually modified the DOM.
  // Resetting selection via sel.removeAllRanges() on every keystroke will
  // silently abort IME composition on mobile keyboards and Safari.
  if (changed && caret != null) setCaretCharOffset(caret)
}
function onFocus() {
  focused.value = true
}
function onBlur() {
  focused.value = false
  enlarged.value = false
}
// ── caret helpers ─────────────────────────────────────────────
function currentSelection(): { node: Node; offset: number } | null {
  if (typeof window === 'undefined') return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!r.collapsed) return null
  const el = editor.value
  if (!el || !el.contains(r.startContainer)) return null
  return { node: r.startContainer, offset: r.startOffset }
}

function placeCaret(node: Node, offset: number) {
  if (typeof window === 'undefined') return
  const sel = window.getSelection()
  if (!sel) return
  const r = document.createRange()
  r.setStart(node, offset)
  r.collapse(true)
  sel.removeAllRanges()
  sel.addRange(r)
}

// ── trigger detection (@ assets, / favorites) ─────────────────
function detectTrigger() {
  const cur = currentSelection()
  if (!cur || cur.node.nodeType !== Node.TEXT_NODE) { closePopover(); return }
  const textNode = cur.node as Text
  const upto = textNode.data.slice(0, cur.offset)
  const m = upto.match(/([@/])([^\s@/]*)$/)
  if (!m) { closePopover(); return }
  const ch = m[1]
  if (ch === '@' && !props.allowKinds.length) { closePopover(); return }
  trigger.value = ch === '@' ? 'asset' : 'fav'
  triggerNode = textNode
  triggerStartOffset = cur.offset - m[0].length
  triggerEndOffset = cur.offset
  query.value = m[2] || ''
  activeIndex.value = 0
  visibleCount.value = PAGE
  if (trigger.value === 'asset') { listVersion.value++; void ensureAssets() }
}

function closePopover() {
  trigger.value = null
  triggerNode = null
  triggerStartOffset = -1
  triggerEndOffset = -1
  query.value = ''
  activeIndex.value = 0
}

// ── popover positioning ───────────────────────────────────────
// The popover is teleported to <body> and fixed-positioned (anchored to the
// editor's top edge, growing upward) so it can never be clipped by the prompt
// box border / column overflow / stacking contexts — the same robust technique
// the task hover-card uses. We snapshot the editor rect on open and refresh it
// on scroll / resize / typing (the editor height changes as content grows).
const popoverRect = ref<DOMRect | null>(null)
function updatePopoverPos() {
  const el = editor.value
  popoverRect.value = el ? el.getBoundingClientRect() : null
}
const popoverStyle = computed<Record<string, string | undefined>>(() => {
  const r = popoverRect.value
  if (!r || typeof window === 'undefined') return {}
  return {
    left: `${r.left}px`,
    width: `${r.width}px`,
    bottom: `${window.innerHeight - r.top + 8}px`,
  }
})
watch(showPopover, (open) => {
  if (open) {
    updatePopoverPos()
    if (typeof window !== 'undefined') {
      window.addEventListener('scroll', updatePopoverPos, true)
      window.addEventListener('resize', updatePopoverPos)
    }
  } else if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', updatePopoverPos, true)
    window.removeEventListener('resize', updatePopoverPos)
  }
})

// Remove the active trigger token from its text node; returns where the caret
// should land (node + offset) so the caller can insert content there.
function removeTriggerToken(): { node: Text; offset: number } | null {
  if (!triggerNode) return null
  const data = triggerNode.data
  triggerNode.data = data.slice(0, triggerStartOffset) + data.slice(triggerEndOffset)
  return { node: triggerNode, offset: triggerStartOffset }
}

// ── chip element ──────────────────────────────────────────────
function buildChip(sig: string, kind: 'image' | 'video' | 'audio', url: string): HTMLElement {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.dataset.refSig = sig
  chip.dataset.refKind = kind
  chip.dataset.refLabel = ''
  // Pill that sits cleanly on the text baseline; radius matches other UI (5px),
  // with margin so it doesn't crowd the caret/text.
  chip.className = 'relative mx-1 inline-flex h-[22px] items-center gap-1 rounded-[5px] border border-primary-200 bg-primary-50 pl-0.5 pr-2 align-text-bottom text-primary-700 select-none'

  const thumb = document.createElement('span')
  thumb.className = 'grid h-[18px] w-[18px] place-items-center overflow-hidden rounded-[3px] bg-[var(--c-surface)]'
  if (kind === 'image') {
    const img = document.createElement('img')
    img.src = url
    img.className = 'h-full w-full object-cover'
    thumb.appendChild(img)
  } else if (kind === 'video') {
    const vid = document.createElement('video')
    vid.src = url
    vid.muted = true
    vid.className = 'h-full w-full object-cover'
    thumb.appendChild(vid)
  } else {
    thumb.textContent = '♪'
    thumb.classList.add('text-[10px]', 'text-[var(--c-fg-4)]')
  }
  chip.appendChild(thumb)

  const label = document.createElement('span')
  label.dataset.chipLabel = ''
  label.className = 'text-[12px] font-medium leading-none'
  label.textContent = '…'
  chip.appendChild(label)
  return chip
}

interface RestoreRef { sig: string; kind: 'image' | 'video' | 'audio'; url: string }
// Rebuild the editor from stored text + refs, turning 「图片N」/「视频N」/「音频N」
// tokens back into inline chips. Used by retry (复刻参数) so @-mentions re-render
// instead of showing as literal bracketed text.
function restoreContent(text: string, refsByKind: { image: RestoreRef[]; video: RestoreRef[]; audio: RestoreRef[] }) {
  const el = editor.value
  if (!el) return
  el.innerHTML = ''
  const zhToKind: Record<string, 'image' | 'video' | 'audio'> = { 图片: 'image', 视频: 'video', 音频: 'audio' }
  const re = /「(图片|视频|音频)(\d+)」/g
  let last = 0
  let m: RegExpExecArray | null
  const append = (node: Node) => el.appendChild(node)
  while ((m = re.exec(text))) {
    if (m.index > last) append(document.createTextNode(text.slice(last, m.index)))
    const kind = zhToKind[m[1] || '']
    const idx = Number(m[2]) - 1
    const matchedRef = kind ? refsByKind[kind][idx] : undefined
    if (matchedRef) append(buildChip(matchedRef.sig, matchedRef.kind, matchedRef.url))
    else append(document.createTextNode(m[0])) // no matching ref → keep literal
    last = m.index + m[0].length
  }
  if (last < text.length) append(document.createTextNode(text.slice(last)))
  isEmpty.value = el.textContent?.trim() === '' && !el.querySelector('[data-ref-sig]')
  syncFromDom()
}

defineExpose({ restoreContent })

// Insert a node (chip) or text at the current trigger token location.
function insertAtTrigger(content: Node | string) {
  const pos = removeTriggerToken()
  if (!pos) return
  const { node, offset } = pos
  const after = node.splitText(offset)
  const insertedNode = typeof content === 'string' ? document.createTextNode(content) : content
  node.parentNode!.insertBefore(insertedNode, after)
  closePopover()
  // Caret right after the inserted content.
  nextTick(() => {
    editor.value?.focus()
    placeCaret(after, 0)
    syncFromDom()
  })
}




function chooseAsset(a: PickerAsset) {
  // Add it as a reference (parent dedups), then drop an inline chip at the @.
  emit('pick-asset', a)
  const sig = assetSig(a)
  // 用户主动重新引用 → 撤销之前的「已删」记录，让它恢复可被对账。
  for (const tok of assetTokens(a)) dismissedTokens.value.delete(tok)
  insertAtTrigger(buildChip(sig, a.kind, a.url))
}

function chooseFavorite(text: string) {
  insertAtTrigger(text)
}

// Infinite scroll inside the popover list
function onListScroll(e: Event) {
  const el = e.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    visibleCount.value += PAGE
  }
}
// ── event handlers ────────────────────────────────────────────
function onInput(e: Event) {
  // During IME composition, the DOM contains uncommitted preedit text.
  // Syncing now would emit partial pinyin as the modelValue, and the
  // parent's watcher would echo it back via el.textContent = v, which
  // destroys the composition session → first character lost / can't
  // select Chinese on mobile. Defer everything until compositionend.
  // Check both our flag AND the native InputEvent.isComposing for robustness
  // (event ordering between compositionend and input varies by browser).
  if (isComposing.value || (e instanceof InputEvent && e.isComposing)) return
  // Strip stale overflow wrappers before serializing so text stays clean,
  // then re-apply the highlight (caret-preserving) after.
  clearOverflowMarks()
  syncFromDom()
  refreshOverflow()
  detectTrigger()
  if (showPopover.value) updatePopoverPos()
}

function onCompositionStart() {
  isComposing.value = true
}
function onCompositionEnd() {
  isComposing.value = false
  // On some browsers (Chrome / Android WebView), compositionend fires BEFORE
  // the final input event that commits the text. Deferring the sync to the
  // next microtask ensures the DOM already contains the committed characters
  // when we serialize.
  nextTick(() => {
    clearOverflowMarks()
    syncFromDom()
    refreshOverflow()
    detectTrigger()
    if (showPopover.value) updatePopoverPos()
  })
}

function insertText(t: string) {
  const el = editor.value
  if (typeof window === 'undefined' || !el) return
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) {
    // No selection (e.g. select-all then the range was lost) — append to end.
    el.appendChild(document.createTextNode(t))
    placeCaret(el, el.childNodes.length)
    clearOverflowMarks(); syncFromDom(); refreshOverflow()
    return
  }
  const range = sel.getRangeAt(0)
  // Guard: range must be inside the editor; otherwise append at end.
  if (!el.contains(range.commonAncestorContainer)) {
    el.appendChild(document.createTextNode(t))
    placeCaret(el, el.childNodes.length)
    clearOverflowMarks(); syncFromDom(); refreshOverflow()
    return
  }
  // Prefer execCommand('insertText'): it records the edit in the browser's
  // native undo stack (so Cmd+Z / Cmd+Y / Cmd+Shift+Z work) and handles
  // deleting the current selection itself. Manual Range mutation below is the
  // fallback for the rare engine that rejects it.
  el.focus()
  let inserted = false
  try {
    inserted = document.execCommand('insertText', false, t)
  } catch { inserted = false }
  if (!inserted) {
    // Delete any selected content (covers select-all → paste/replace), then insert.
    range.deleteContents()
    const node = document.createTextNode(t)
    range.insertNode(node)
    // Caret right after the inserted text.
    const after = document.createRange()
    after.setStartAfter(node)
    after.collapse(true)
    sel.removeAllRanges()
    sel.addRange(after)
  }
  clearOverflowMarks()
  syncFromDom()
  refreshOverflow()
}

function onPaste(e: ClipboardEvent) {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain') || ''
  if (text) insertText(text)
}

function onKeydown(e: KeyboardEvent) {
  // During IME composition, ALL key events belong to the input method (e.g.
  // Enter = confirm candidate, Escape = cancel composition, arrows = navigate
  // candidates). We must not intercept any of them.
  if (isComposing.value || e.isComposing) return
  if (showPopover.value && !popoverEmpty.value) {
    const list = trigger.value === 'asset' ? orderedAssets.value : visibleFavorites.value
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex.value = (activeIndex.value + 1) % list.length; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex.value = (activeIndex.value - 1 + list.length) % list.length; return }
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault()
      if (trigger.value === 'asset') chooseAsset(orderedAssets.value[activeIndex.value] as PickerAsset)
      else chooseFavorite((visibleFavorites.value[activeIndex.value] as any).text)
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); closePopover(); return }
  }
  // Esc (no popover) → shrink the enlarged editor.
  if (e.key === 'Escape' && enlarged.value) { e.preventDefault(); enlarged.value = false; return }
  // Tab → toggle the enlarged editor (don't move focus away).
  if (e.key === 'Tab' && !e.shiftKey && !showPopover.value) {
    e.preventDefault()
    enlarged.value = !enlarged.value
    return
  }
  // submit
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault()
    emit('submit')
    return
  }
  // Plain Enter → insert "\n" ourselves (avoid contenteditable <div> wrapping).
  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
    e.preventDefault()
    insertText('\n')
    return
  }
  // Atomic chip deletion: Backspace immediately before a chip removes it whole.
  if (e.key === 'Backspace') {
    const cur = currentSelection()
    if (!cur) return
    let chip: HTMLElement | null = null
    if (cur.node.nodeType === Node.TEXT_NODE && cur.offset === 0) {
      let prev = (cur.node as Text).previousSibling
      while (prev && prev.nodeType === Node.TEXT_NODE && !(prev as Text).data) prev = prev.previousSibling
      if (prev && (prev as HTMLElement).dataset?.refSig) chip = prev as HTMLElement
    } else if (cur.node.nodeType === Node.ELEMENT_NODE && cur.offset > 0) {
      const before = cur.node.childNodes[cur.offset - 1] as HTMLElement
      if (before && before.dataset?.refSig) chip = before
    }
    if (chip) {
      e.preventDefault()
      const sig = chip.dataset.refSig!
      // 删提示词不删素材：只从输入框里去掉这个 chip，素材仍留在素材条 / @ 列表。
      // 记下它的所有 token，避免后续排序/新增触发对账时又把 chip 补回来（永久不出现）。
      for (const tok of sigTokens(sig)) dismissedTokens.value.add(tok)
      // Record caret as a char offset at the chip's position, remove the chip,
      // then restore by offset. An empty text-node anchor would be wiped by
      // normalize(), dropping focus/caret — offset survives.
      const caretAt = getCaretCharOffset() ?? 0
      // Chips count as 1 unit in the offset model; removing one shifts the caret
      // back by 1.
      const chipLen = 1
      chip.remove()
      clearOverflowMarks()
      syncFromDom()
      refreshOverflow()
      const target = Math.max(0, caretAt - chipLen)
      const restore = () => {
        const el = editor.value
        if (!el) return
        el.focus()
        setCaretCharOffset(target)
      }
      restore()
      nextTick(restore)
    }
  }
}

// ── modelValue sync (external sets: retry / polish / reset) ────
// When the parent replaces the prompt as plain text, rebuild the editor from
// it. Chips can't be reconstructed from a bare string, so an external set
// collapses everything to plain text (acceptable: retry/polish paths).
watch(() => props.modelValue, (v) => {
  if (v === lastEmitted) return
  // CRITICAL: never clobber the DOM during IME composition — el.textContent=v
  // would destroy the preedit underline text and abort the input method.
  if (isComposing.value) return
  const el = editor.value
  if (!el) return
  el.textContent = v || ''
  lastEmitted = v || ''
  isEmpty.value = !(v && v.length)
  emit('update:segments', v ? [{ type: 'text', text: v }] : [])
})

// When the reference strip changes (reorder / add / remove), reconcile the
// inline chips (add/remove to mirror the strip), relabel them, and re-emit the
// prompt text so 图片N indices stay in sync. Caret is preserved across the
// DOM mutation so a strip edit doesn't disrupt typing.
watch(() => props.mentionedRefs, () => {
  if (!editor.value) return
  const caret = getCaretCharOffset()
  clearOverflowMarks()
  reconcileChips()
  syncFromDom()
  refreshOverflow()
  if (caret != null) setCaretCharOffset(caret)
}, { deep: true })

onMounted(() => {
  mounted.value = true
  const el = editor.value
  if (el && props.modelValue) {
    el.textContent = props.modelValue
    lastEmitted = props.modelValue
    isEmpty.value = false
  }
  document.addEventListener('mousedown', onDocMouseDown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  if (typeof window !== 'undefined') {
    window.removeEventListener('scroll', updatePopoverPos, true)
    window.removeEventListener('resize', updatePopoverPos)
  }
})

// Close the @ / popover when clicking outside the editor root.
function onDocMouseDown(e: MouseEvent) {
  if (!showPopover.value) return
  const target = e.target as Node
  const root = rootRef.value
  const pop = popoverRef.value
  // Popover is teleported to <body>, so check both the editor root and the
  // popover element — a click in either should NOT close it.
  if ((root && root.contains(target)) || (pop && pop.contains(target))) return
  closePopover()
}

</script>

<template>


  <div ref="rootRef" class="relative">
    <div class="relative">
      <div ref="editor" contenteditable="true" role="textbox"
        class="prompt-editor scroll-area block w-full overflow-y-auto whitespace-pre-wrap break-words border-0 bg-transparent px-4 pb-9 pt-3 text-[14px] leading-[1.6] text-[var(--c-fg)] outline-none transition-[min-height,max-height]"
        :class="enlarged ? 'min-h-[62vh]' : (mounted && (focused || !isEmpty) ? 'min-h-[128px]' : 'min-h-[56px]')"
        :style="{ maxHeight: enlarged ? '72vh' : '128px' }" @input="onInput" @paste="onPaste"
        @keydown="onKeydown" @focus="onFocus" @blur="onBlur"
        @compositionstart="onCompositionStart" @compositionend="onCompositionEnd" />
      <div v-show="isEmpty"
        class="pointer-events-none absolute left-4 top-3 text-[14px] leading-[1.6] text-[var(--c-fg-7)]">输入提示词… @ 引用素材，/ 调用收藏，<kbd class="rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1 font-mono text-[11px]">Tab</kbd> 放大</div>
      <!-- in-box bottom-right toolbar: char count + polish (slot from parent) -->
      <div class="pointer-events-none absolute inset-x-3 bottom-1.5 flex items-center justify-between gap-2">
        <span class="text-[11px] tabular-nums" :class="overLimit ? 'font-medium text-red-500' : 'text-[var(--c-fg-7)]'">
          {{ charCount ? `${charCount} / ${MAX_CHARS}` : '' }}
        </span>
        <div class="pointer-events-auto flex items-center gap-1.5">
          <slot name="toolbar" />
        </div>
      </div>
    </div>
    <!-- PLACEHOLDER_TEMPLATE -->
    <!-- @ / popover: teleported to body + fixed-positioned (anchored above the
         editor) so it's never clipped by the prompt box / column overflow. -->
    <Teleport to="body">
      <div v-if="showPopover" ref="popoverRef"
        class="fixed z-[60] overflow-hidden rounded-[8px] border border-[var(--c-border)] bg-[var(--c-surface)] shadow-wf"
        :style="popoverStyle">
      <div
        class="flex items-center justify-between border-b border-[var(--c-border-2)] bg-[var(--c-surface-2)] px-3 py-1.5 text-[11px] text-[var(--c-fg-4)]">
        <span>{{ trigger === 'asset' ? '引用素材' : '收藏的提示词' }}</span>
        <span class="font-mono">↑↓ 选择 · Enter 确认 · Esc 关闭</span>
      </div>

      <!-- asset list — keyed by listVersion so new data destroys & rebuilds the
           rows from scratch (no stale/blank thumbnails). Skeleton while loading. -->
      <div v-if="trigger === 'asset'" class="scroll-area max-h-[280px] overflow-y-auto overflow-x-hidden p-1" @scroll="onListScroll">
        <div v-if="loadingAssets && !assetRows.length" class="space-y-1">
          <div v-for="n in 6" :key="n" class="flex items-center gap-2.5 rounded-[4px] px-2 py-1.5">
            <div class="h-10 w-10 flex-shrink-0 animate-pulse rounded-[4px] bg-[var(--c-surface-3)]" />
            <div class="min-w-0 flex-1 space-y-1.5">
              <div class="h-3 w-3/4 animate-pulse rounded bg-[var(--c-surface-3)]" />
              <div class="h-2.5 w-1/3 animate-pulse rounded bg-[var(--c-surface-3)]" />
            </div>
          </div>
        </div>
        <div v-else-if="popoverEmpty" class="py-6 text-center text-[12px] text-[var(--c-fg-4)]">没有匹配的素材</div>
        <div v-else :key="listVersion">
          <template v-for="row in assetRows" :key="row.key">
            <div v-if="row.kind === 'header'" class="px-2 py-1 text-[10px] font-medium text-[var(--c-fg-5)]">{{ row.label }}</div>
            <div v-else
              class="group flex cursor-pointer items-center gap-2.5 rounded-[4px] px-2 py-1.5 transition"
              :class="row.navIndex === activeIndex ? 'bg-primary-50' : 'hover:bg-[var(--c-surface-2)]'"
              @mouseenter="activeIndex = row.navIndex" @mousedown.prevent @click="chooseAsset(row.asset)">
              <div class="relative h-10 w-10 flex-shrink-0 overflow-hidden rounded-[4px] border bg-[var(--c-surface-2)]"
                :class="row.selected ? 'border-primary-300' : 'border-[var(--c-border-2)]'">
                <img v-if="row.asset.kind === 'image'" :src="row.asset.url" class="h-full w-full object-cover" loading="eager" decoding="async" />
                <video v-else-if="row.asset.kind === 'video'" :src="row.asset.url" class="h-full w-full object-cover" muted playsinline preload="metadata" />
                <div v-else class="grid h-full w-full place-items-center"><UIcon name="i-carbon-music" class="h-4 w-4 text-[var(--c-fg-4)]" /></div>
                <span v-if="row.selected" class="absolute right-0 top-0 grid h-3.5 w-3.5 place-items-center rounded-bl bg-primary-500 text-white"><UIcon name="i-carbon-checkmark" class="h-2.5 w-2.5" /></span>
              </div>
              <div class="min-w-0 flex-1">
                <div class="truncate text-[12px] text-[var(--c-fg)]">{{ row.asset.filename || row.asset.meta?.prompt || '未命名素材' }}</div>
                <div class="flex items-center gap-1.5 text-[10px] text-[var(--c-fg-6)]">
                  <span class="rounded-[2px] bg-[var(--c-surface-3)] px-1">{{ kindLabel(row.asset.kind) }}</span>
                  <span class="font-mono">#{{ row.asset.meta?.task_id ?? row.asset.id.replace('up_', '') }}</span>
                </div>
              </div>
              <button v-if="!row.selected" type="button"
                class="hidden h-6 w-6 flex-shrink-0 place-items-center rounded-[4px] text-[var(--c-fg-6)] transition hover:bg-red-50 hover:text-red-600 group-hover:grid"
                title="删除素材" @mousedown.prevent @click="deleteAsset(row.asset, $event)">
                <UIcon name="i-carbon-trash-can" class="h-3.5 w-3.5" />
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- favorites list -->
      <div v-else class="scroll-area max-h-[260px] overflow-y-auto p-1" @scroll="onListScroll">
        <div v-if="popoverEmpty" class="py-6 text-center text-[12px] text-[var(--c-fg-4)]">暂无收藏（在概览中点收藏）</div>
        <button v-for="(f, i) in visibleFavorites" :key="f.id" type="button"
          class="flex w-full items-start gap-2 rounded-[4px] px-2.5 py-2 text-left transition"
          :class="i === activeIndex ? 'bg-primary-50' : 'hover:bg-[var(--c-surface-2)]'" @mouseenter="activeIndex = i"
          @mousedown.prevent @click="chooseFavorite(f.text)">
          <UIcon name="i-carbon-bookmark-filled" class="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-primary-500" />
          <span class="line-clamp-2 text-[13px] text-[var(--c-fg-3)]">{{ f.text }}</span>
        </button>
      </div>
    </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* Over-limit prompt tail — highlighted on blur to signal it won't be sent. */
.prompt-editor :deep(.pe-overflow) {
  background-color: rgba(239, 68, 68, 0.18);
  border-radius: 2px;
  text-decoration: underline wavy rgba(239, 68, 68, 0.6);
}
</style>
