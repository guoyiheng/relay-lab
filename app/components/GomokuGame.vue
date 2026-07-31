<script setup lang="ts">
type Player = 0 | 1 | 2
type Phase = 'idle' | 'human' | 'thinking' | 'paused' | 'won' | 'lost' | 'draw'
type GridSegment = { x1: number; y1: number; x2: number; y2: number; active: boolean }

const BOARD_SIZE = 15
const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const
const AI_DELAY = 320
const SEARCH_DEPTH = 4
const ROOT_CANDIDATE_LIMIT = 18
const BRANCH_CANDIDATE_LIMIT = 8
const SEARCH_BUDGET = 420
const props = defineProps<{ paused?: boolean }>()
const emit = defineEmits<{ 'active-change': [active: boolean] }>()

const container = ref<HTMLElement | null>(null)
const viewport = reactive({ width: 1200, height: 800 })
const board = ref<Player[]>(createBoard())
const phase = ref<Phase>('idle')
const lastMove = ref<number | null>(null)
const winningLine = ref<number[]>([])
let aiTimer: ReturnType<typeof setTimeout> | undefined
let phaseBeforePause: 'human' | 'thinking' = 'human'
let reduceMotion: MediaQueryList | undefined
let resizeObserver: ResizeObserver | undefined

const cellSize = computed(() => Math.max(22, Math.min(40, Math.floor(Math.min(viewport.width - 16, viewport.height - 64) / BOARD_SIZE))))
const playableSpan = computed(() => cellSize.value * (BOARD_SIZE - 1))
const originX = computed(() => (viewport.width - playableSpan.value) / 2)
const originY = computed(() => viewport.width <= 640 ? 28 : (viewport.height - playableSpan.value) / 2)
const gameStyle = computed(() => ({
  '--gomoku-cell': `${cellSize.value}px`,
}))

const pointStyles = computed(() => Array.from({ length: BOARD_SIZE * BOARD_SIZE }, (_, index) => ({
  left: `${originX.value + columnOf(index) * cellSize.value}px`,
  top: `${originY.value + rowOf(index) * cellSize.value}px`,
})))

const gridSegments = computed<GridSegment[]>(() => {
  const span = Math.ceil(Math.max(viewport.width, viewport.height) / cellSize.value) + 2
  const segments: GridSegment[] = []
  for (let column = -span; column <= span; column += 1) {
    const x = originX.value + column * cellSize.value
    if (x < -cellSize.value || x > viewport.width + cellSize.value) continue
    for (let row = -span; row <= span; row += 1) {
      const y1 = originY.value + row * cellSize.value
      const y2 = y1 + cellSize.value
      if (y2 < 0 || y1 > viewport.height) continue
      segments.push({ x1: x, y1, x2: x, y2, active: column >= 0 && column <= BOARD_SIZE - 1 && row >= 0 && row < BOARD_SIZE - 1 })
    }
  }
  for (let row = -span; row <= span; row += 1) {
    const y = originY.value + row * cellSize.value
    if (y < -cellSize.value || y > viewport.height + cellSize.value) continue
    for (let column = -span; column <= span; column += 1) {
      const x1 = originX.value + column * cellSize.value
      const x2 = x1 + cellSize.value
      if (x2 < 0 || x1 > viewport.width) continue
      segments.push({ x1, y1: y, x2, y2: y, active: row >= 0 && row <= BOARD_SIZE - 1 && column >= 0 && column < BOARD_SIZE - 1 })
    }
  }
  return segments
})

const statusText = computed(() => {
  if (phase.value === 'idle') return ''
  if (phase.value === 'human') return '你执黑 · 点击棋盘落子'
  if (phase.value === 'thinking') return 'AI 思考中…'
  if (phase.value === 'paused') return '对局已暂停 · 点击棋盘继续'
  if (phase.value === 'won') return '你赢了 · 黑棋五连'
  if (phase.value === 'lost') return 'AI 赢了 · 再试一次'
  if (phase.value === 'draw') return '和棋 · 棋盘已满'
  return ''
})

const isResult = computed(() => ['won', 'lost', 'draw'].includes(phase.value))

function createBoard(): Player[] {
  return Array.from({ length: BOARD_SIZE * BOARD_SIZE }, () => 0 as Player)
}

function rowOf(index: number) {
  return Math.floor(index / BOARD_SIZE)
}

function columnOf(index: number) {
  return index % BOARD_SIZE
}

function indexOf(row: number, column: number) {
  return row * BOARD_SIZE + column
}

function isInside(row: number, column: number) {
  return row >= 0 && row < BOARD_SIZE && column >= 0 && column < BOARD_SIZE
}

function lineForMove(state: Player[], index: number, player: Player): number[] {
  const row = rowOf(index)
  const column = columnOf(index)

  for (const [rowStep, columnStep] of DIRECTIONS) {
    const line = [index]
    for (const direction of [-1, 1]) {
      let nextRow = row + rowStep * direction
      let nextColumn = column + columnStep * direction
      while (isInside(nextRow, nextColumn) && state[indexOf(nextRow, nextColumn)] === player) {
        line.push(indexOf(nextRow, nextColumn))
        nextRow += rowStep * direction
        nextColumn += columnStep * direction
      }
    }
    if (line.length >= 5) return line
  }
  return []
}

function countDirection(state: Player[], row: number, column: number, rowStep: number, columnStep: number, player: Player) {
  let count = 0
  let nextRow = row + rowStep
  let nextColumn = column + columnStep
  while (isInside(nextRow, nextColumn) && state[indexOf(nextRow, nextColumn)] === player) {
    count += 1
    nextRow += rowStep
    nextColumn += columnStep
  }
  return { count, nextRow, nextColumn }
}

function patternScore(state: Player[], index: number, player: Player) {
  const row = rowOf(index)
  const column = columnOf(index)
  let total = 0

  for (const [rowStep, columnStep] of DIRECTIONS) {
    const forward = countDirection(state, row, column, rowStep, columnStep, player)
    const backward = countDirection(state, row, column, -rowStep, -columnStep, player)
    const length = 1 + forward.count + backward.count
    const openEnds = Number(
      isInside(forward.nextRow, forward.nextColumn)
      && state[indexOf(forward.nextRow, forward.nextColumn)] === 0,
    ) + Number(
      isInside(backward.nextRow, backward.nextColumn)
      && state[indexOf(backward.nextRow, backward.nextColumn)] === 0,
    )

    if (length >= 5) total += 1_000_000
    else if (length === 4) total += openEnds === 2 ? 100_000 : openEnds === 1 ? 12_000 : 0
    else if (length === 3) total += openEnds === 2 ? 8_000 : openEnds === 1 ? 900 : 0
    else if (length === 2) total += openEnds === 2 ? 500 : openEnds === 1 ? 100 : 0
    else if (openEnds > 0) total += 10
  }

  return total
}

function playerBoardScore(state: Player[], player: Player) {
  let total = 0

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let column = 0; column < BOARD_SIZE; column += 1) {
      const index = indexOf(row, column)
      if (state[index] !== player) continue

      for (const [rowStep, columnStep] of DIRECTIONS) {
        const previousRow = row - rowStep
        const previousColumn = column - columnStep
        if (isInside(previousRow, previousColumn) && state[indexOf(previousRow, previousColumn)] === player) continue

        let length = 0
        let nextRow = row
        let nextColumn = column
        while (isInside(nextRow, nextColumn) && state[indexOf(nextRow, nextColumn)] === player) {
          length += 1
          nextRow += rowStep
          nextColumn += columnStep
        }

        const openEnds = Number(isInside(previousRow, previousColumn) && state[indexOf(previousRow, previousColumn)] === 0)
          + Number(isInside(nextRow, nextColumn) && state[indexOf(nextRow, nextColumn)] === 0)

        if (length >= 5) total += 10_000_000
        else if (length === 4) total += openEnds === 2 ? 240_000 : openEnds === 1 ? 24_000 : 0
        else if (length === 3) total += openEnds === 2 ? 16_000 : openEnds === 1 ? 1_800 : 0
        else if (length === 2) total += openEnds === 2 ? 700 : openEnds === 1 ? 140 : 0
        else if (openEnds > 0) total += 12
      }
    }
  }

  return total
}

function evaluateBoard(state: Player[]) {
  return playerBoardScore(state, 2) - playerBoardScore(state, 1) * 1.08
}

function candidateMoves(state: Player[]) {
  const occupied = state.reduce<number>((count, cell) => count + Number(cell !== 0), 0)
  if (!occupied) return [indexOf(7, 7)]

  const candidates = new Set<number>()
  for (let index = 0; index < state.length; index += 1) {
    if (state[index] !== 0) continue
    const row = rowOf(index)
    const column = columnOf(index)
    for (let rowOffset = -2; rowOffset <= 2; rowOffset += 1) {
      for (let columnOffset = -2; columnOffset <= 2; columnOffset += 1) {
        if (isInside(row + rowOffset, column + columnOffset)
          && state[indexOf(row + rowOffset, column + columnOffset)] !== 0) {
          candidates.add(index)
        }
      }
    }
  }
  return [...candidates]
}

function orderedCandidates(state: Player[], player: 1 | 2, limit: number) {
  return candidateMoves(state)
    .map(index => {
      const attack = patternScore(state, index, player)
      const defense = patternScore(state, index, player === 1 ? 2 : 1)
      const centerDistance = Math.abs(rowOf(index) - 7) + Math.abs(columnOf(index) - 7)
      state[index] = player
      const threats = countWinningMoves(state, player)
      state[index] = 0
      return { index, score: attack * 1.2 + defense * 1.14 + threats * 400_000 - centerDistance * 3 }
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(candidate => candidate.index)
}

function wouldWin(state: Player[], index: number, player: Player) {
  if (state[index] !== 0) return false
  state[index] = player
  const result = lineForMove(state, index, player).length >= 5
  state[index] = 0
  return result
}

function countWinningMoves(state: Player[], player: 1 | 2) {
  return candidateMoves(state).reduce((count, index) => count + Number(wouldWin(state, index, player)), 0)
}

function minimax(state: Player[], depth: number, alpha: number, beta: number, maximizing: boolean, deadline: number): number {
  if (Date.now() >= deadline) return evaluateBoard(state)
  if (depth === 0) return evaluateBoard(state)

  const player = maximizing ? 2 : 1
  const candidates = orderedCandidates(state, player, BRANCH_CANDIDATE_LIMIT)
  if (!candidates.length) return evaluateBoard(state)

  if (maximizing) {
    let bestScore = Number.NEGATIVE_INFINITY
    for (const index of candidates) {
      state[index] = 2
      const score = lineForMove(state, index, 2).length >= 5
        ? 10_000_000 + depth * 10_000
        : minimax(state, depth - 1, alpha, beta, false, deadline)
      state[index] = 0
      bestScore = Math.max(bestScore, score)
      alpha = Math.max(alpha, score)
      if (beta <= alpha || Date.now() >= deadline) break
    }
    return bestScore
  }

  let bestScore = Number.POSITIVE_INFINITY
  for (const index of candidates) {
    state[index] = 1
    const score = lineForMove(state, index, 1).length >= 5
      ? -10_000_000 - depth * 10_000
      : minimax(state, depth - 1, alpha, beta, true, deadline)
    state[index] = 0
    bestScore = Math.min(bestScore, score)
    beta = Math.min(beta, score)
    if (beta <= alpha || Date.now() >= deadline) break
  }
  return bestScore
}

function chooseAiMove(state: Player[]) {
  const candidates = orderedCandidates(state, 2, ROOT_CANDIDATE_LIMIT)
  const winningMove = candidates.find(index => wouldWin(state, index, 2))
  if (winningMove !== undefined) return winningMove

  const blockingMove = candidates.find(index => wouldWin(state, index, 1))
  if (blockingMove !== undefined) return blockingMove

  let bestIndex = candidates[0] ?? indexOf(7, 7)
  let bestScore = Number.NEGATIVE_INFINITY
  const deadline = Date.now() + SEARCH_BUDGET

  for (const index of candidates) {
    state[index] = 2
    const score = lineForMove(state, index, 2).length >= 5
      ? 10_000_000
      : minimax(state, SEARCH_DEPTH - 1, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY, false, deadline)
    state[index] = 0

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
    if (Date.now() >= deadline) break
  }

  return bestIndex
}

function startGame() {
  if (phase.value === 'thinking' || phase.value === 'human') return
  board.value = createBoard()
  winningLine.value = []
  lastMove.value = null
  phase.value = 'human'
  emit('active-change', true)
}

function resumeGame() {
  if (phase.value !== 'paused') return
  phase.value = phaseBeforePause
  emit('active-change', true)
  if (phase.value === 'thinking') scheduleAiMove()
}

function scheduleAiMove() {
  if (aiTimer) clearTimeout(aiTimer)
  aiTimer = setTimeout(() => {
    aiTimer = undefined
    if (phase.value !== 'thinking') return
    const aiIndex = chooseAiMove(board.value)
    board.value[aiIndex] = 2
    lastMove.value = aiIndex
    const aiLine = lineForMove(board.value, aiIndex, 2)
    if (aiLine.length >= 5) {
      winningLine.value = aiLine
      phase.value = 'lost'
    } else if (!board.value.includes(0)) {
      phase.value = 'draw'
    } else {
      phase.value = 'human'
    }
  }, reduceMotion?.matches ? 0 : AI_DELAY)
}

function finishHumanMove(index: number) {
  board.value[index] = 1
  lastMove.value = index
  emit('active-change', true)
  const line = lineForMove(board.value, index, 1)
  if (line.length >= 5) {
    winningLine.value = line
    phase.value = 'won'
    return
  }
  if (!board.value.includes(0)) {
    phase.value = 'draw'
    return
  }

  phase.value = 'thinking'
  scheduleAiMove()
}

function handleCellClick(index: number) {
  if (phase.value === 'idle' || isResult.value) {
    startGame()
    return
  }
  if (phase.value === 'paused') {
    resumeGame()
    return
  }
  if (phase.value !== 'human' || board.value[index] !== 0) return
  finishHumanMove(index)
}

watch(
  () => props.paused,
  paused => {
    if (paused && (phase.value === 'human' || phase.value === 'thinking')) {
      phaseBeforePause = phase.value
      if (aiTimer) clearTimeout(aiTimer)
      aiTimer = undefined
      phase.value = 'paused'
    }
  },
)

onMounted(() => {
  reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  resizeObserver = new ResizeObserver(([entry]) => {
    if (!entry) return
    viewport.width = entry.contentRect.width
    viewport.height = entry.contentRect.height
  })
  if (container.value) resizeObserver.observe(container.value)
})

onBeforeUnmount(() => {
  if (aiTimer) clearTimeout(aiTimer)
  resizeObserver?.disconnect()
})
</script>

<template>
  <div ref="container" class="gomoku-game absolute inset-0" :style="gameStyle" aria-label="五子棋对局">
    <svg class="gomoku-lines" :viewBox.attr="`0 0 ${viewport.width} ${viewport.height}`" preserveAspectRatio="none" aria-hidden="true">
      <line
        v-for="(segment, index) in gridSegments"
        :key="index"
        class="gomoku-line"
        :class="{ 'gomoku-line--active': segment.active }"
        :x1.attr="segment.x1"
        :y1.attr="segment.y1"
        :x2.attr="segment.x2"
        :y2.attr="segment.y2"
      />
    </svg>

    <div class="gomoku-points" role="grid" aria-label="五子棋棋盘">
      <span
        v-for="(cell, index) in board"
        :key="index"
        role="gridcell"
        class="gomoku-cell"
        :style="pointStyles[index]"
        :class="{
          'gomoku-cell--last': lastMove === index,
          'gomoku-cell--winning': winningLine.includes(index),
        }"
        :aria-label="cell === 1 ? '黑棋' : cell === 2 ? '白棋' : '空位'"
        @click="handleCellClick(index)"
      >
        <span v-if="cell" class="gomoku-stone" :class="cell === 1 ? 'gomoku-stone--black' : 'gomoku-stone--white'" />
      </span>
    </div>

    <div v-if="statusText" class="gomoku-status" role="status" aria-live="polite">
      <span>{{ statusText }}</span>
      <button v-if="isResult" type="button" class="gomoku-reset" aria-label="重新开始" title="重新开始" @click.stop="startGame">
        <UIcon name="i-carbon-renew" class="h-4 w-4" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.gomoku-game {
  z-index: 0;
  display: grid;
  place-items: center;
  overflow: hidden;
  background: var(--c-surface);
}

.gomoku-lines,
.gomoku-points {
  position: absolute;
  inset: 0;
}

.gomoku-lines {
  z-index: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}

.gomoku-line {
  stroke: color-mix(in srgb, var(--c-fg) 10%, transparent);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.gomoku-line--active {
  stroke: color-mix(in srgb, var(--c-fg) 24%, transparent);
}

.gomoku-points {
  z-index: 1;
  pointer-events: none;
}

.gomoku-cell {
  position: absolute;
  z-index: 1;
  display: grid;
  width: var(--gomoku-cell);
  height: var(--gomoku-cell);
  place-items: center;
  cursor: crosshair;
  pointer-events: auto;
  transform: translate(-50%, -50%);
}

.gomoku-cell::before {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: color-mix(in srgb, #8b5cf6 38%, transparent);
  content: '';
  opacity: 0;
  transform: scale(0.5);
  transition: opacity 150ms ease, transform 150ms cubic-bezier(0.25, 1, 0.5, 1);
}

.gomoku-cell:hover::before {
  opacity: 1;
  transform: scale(1);
}

.gomoku-cell--last {
  background: color-mix(in srgb, #8b5cf6 5%, transparent);
}

.gomoku-cell--winning .gomoku-stone {
  box-shadow: 0 0 0 3px color-mix(in srgb, #8b5cf6 36%, transparent), 0 4px 10px rgb(8 8 8 / 18%);
}

.gomoku-stone {
  position: absolute;
  z-index: 2;
  width: calc(var(--gomoku-cell) * 0.72);
  aspect-ratio: 1;
  border-radius: 50%;
  animation: stone-drop 220ms cubic-bezier(0.22, 1, 0.36, 1) both;
}

.gomoku-stone--black {
  background: #25252a;
  box-shadow: 0 3px 8px rgb(8 8 8 / 26%);
}

.gomoku-stone--white {
  border: 1px solid rgb(8 8 8 / 16%);
  background: #fafafa;
  box-shadow: 0 3px 8px rgb(8 8 8 / 14%);
}

.gomoku-status {
  position: absolute;
  bottom: 22px;
  left: 50%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100vw - 32px);
  padding: 7px 10px 7px 12px;
  border: 1px solid color-mix(in srgb, var(--c-border) 82%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--c-surface) 90%, transparent);
  color: var(--c-fg-3);
  font-size: 12px;
  line-height: 1.2;
  box-shadow: 0 6px 20px rgb(8 8 8 / 8%);
  transform: translateX(-50%);
  z-index: 2;
}

.gomoku-reset {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  border-radius: 4px;
  color: var(--c-fg-4);
  transition: color 150ms ease, background-color 150ms ease;
}

.gomoku-reset:hover {
  background: var(--c-surface-3);
  color: var(--c-fg);
}

@keyframes stone-drop {
  from { opacity: 0; transform: scale(0.58); }
  to { opacity: 1; transform: scale(1); }
}

@media (prefers-reduced-motion: reduce) {
  .gomoku-cell::before,
  .gomoku-reset {
    transition: none;
  }

  .gomoku-stone {
    animation: none;
  }
}

</style>
