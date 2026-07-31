<script setup lang="ts">
// 成本表区块：另一平台的计价/积分参考数据的维护展示，与本项目业务无关（见 CLAUDE.md）。
interface CostEntry {
  id: number
  category: string
  kind: 'image' | 'video'
  model: string
  provider: string | null
  price_mode: 'per_call' | 'per_mtoken' | 'per_second' | null
  resolution: string | null
  duration_s: number | null
  cost_cny: number
  points: number | null
  note: string | null
  sort: number
}
interface ModelGroup { key: string; model: string; rows: CostEntry[] }
interface ProviderGroup { key: string; provider: string; models: ModelGroup[] }
interface CategoryGroup { key: string; category: string; isVideo: boolean; providers: ProviderGroup[]; total: number }

const props = defineProps<{ group: CategoryGroup }>()
const emit = defineEmits<{
  (e: 'delete', entry: CostEntry): void
  (e: 'save', id: number, patch: Partial<CostEntry>): void
}>()

const PRICE_MODE_LABEL: Record<string, string> = { per_call: '按次', per_mtoken: '按量', per_second: '按秒' }
const isVideo = computed(() => props.group.isVideo)
// per_mtoken（按量）的 cost_cny 是费率(元/M token)，新定价/新积分不适用。
function isMetered(e: CostEntry): boolean { return e.price_mode === 'per_mtoken' }
function newPriceOf(e: CostEntry): number { return e.cost_cny * 1.3 }
function newPointsOf(e: CostEntry): number { return Math.round(e.cost_cny * 1.3 * 15) }
// 视频列(分辨率/时长) + 备注列 → 折叠头 colspan。
const colSpan = computed(() => (isVideo.value ? 10 : 8))

// 折叠：平台 & 模型 两级，默认全展开。
const collapsed = ref<Set<string>>(new Set())
function toggle(key: string) {
  const next = new Set(collapsed.value)
  next.has(key) ? next.delete(key) : next.add(key)
  collapsed.value = next
}

// 行内编辑
const editingId = ref<number | null>(null)
const buf = ref<Partial<CostEntry>>({})
function startEdit(e: CostEntry) {
  editingId.value = e.id
  buf.value = {
    category: e.category, price_mode: e.price_mode, resolution: e.resolution,
    duration_s: e.duration_s, cost_cny: e.cost_cny, points: e.points, note: e.note,
  }
}
function cancelEdit() { editingId.value = null; buf.value = {} }
function saveEdit(id: number) { emit('save', id, { ...buf.value }); editingId.value = null; buf.value = {} }
</script>
<!-- TPL_PLACEHOLDER -->
<template>
  <div class="surface">
    <div class="flex items-center gap-1.5 border-b border-[var(--c-border)] px-5 py-3">
      <UIcon :name="isVideo ? 'i-carbon-video' : 'i-carbon-image'" class="h-4 w-4 text-primary-600" />
      <h3 class="text-[14px] font-semibold text-[var(--c-fg)]">{{ group.category }}</h3>
      <span class="text-[11px] text-[var(--c-fg-4)]">{{ group.total }} 条 · {{ group.providers.length }} 个平台</span>
    </div>
    <table class="w-full text-left text-[13px]">
      <thead class="border-b border-[var(--c-border)] text-[12px] text-[var(--c-fg-4)]">
        <tr>
          <th class="px-4 py-2.5 font-medium">平台 / 模型 / 档位</th>
          <th class="px-4 py-2.5 font-medium">定价模式</th>
          <th v-if="isVideo" class="px-4 py-2.5 font-medium">分辨率</th>
          <th v-if="isVideo" class="px-4 py-2.5 text-right font-medium">时长</th>
          <th class="px-4 py-2.5 text-right font-medium">成本(元)</th>
          <th class="px-4 py-2.5 text-right font-medium">新定价(元)<span class="ml-0.5 font-normal text-[var(--c-fg-6)]">(+30%)</span></th>
          <th class="px-4 py-2.5 text-right font-medium">新积分<span class="ml-0.5 font-normal text-[var(--c-fg-6)]">(×15)</span></th>
          <th class="px-4 py-2.5 text-right font-medium">最终积分<span class="ml-0.5 font-normal text-[var(--c-fg-6)]">(手填)</span></th>
          <th class="px-4 py-2.5 font-medium">备注</th>
          <th class="px-4 py-2.5"></th>
        </tr>
      </thead>
      <tbody v-for="prov in group.providers" :key="prov.key" class="border-b border-[var(--c-border)] last:border-0">
        <!-- 平台折叠头 -->
        <tr class="cursor-pointer bg-[var(--c-surface-2)] hover:bg-[var(--c-surface-3)]" @click="toggle(prov.key)">
          <td class="px-4 py-2" :colspan="colSpan">
            <div class="flex items-center gap-1.5">
              <UIcon name="i-carbon-chevron-right" class="h-3.5 w-3.5 text-[var(--c-fg-4)] transition-transform"
                :class="collapsed.has(prov.key) ? '' : 'rotate-90'" />
              <span class="font-semibold text-[var(--c-fg)]">{{ prov.provider }}</span>
              <span class="text-[11px] text-[var(--c-fg-5)]">{{ prov.models.length }} 个模型</span>
            </div>
          </td>
        </tr>
        <template v-if="!collapsed.has(prov.key)">
          <template v-for="mod in prov.models" :key="mod.key">
            <!-- 模型折叠头 -->
            <tr class="cursor-pointer border-t border-[var(--c-border-2)] hover:bg-[var(--c-surface-2)]" @click="toggle(mod.key)">
              <td class="py-1.5 pl-9 pr-4" :colspan="colSpan">
                <div class="flex items-center gap-1.5">
                  <UIcon name="i-carbon-chevron-right" class="h-3 w-3 text-[var(--c-fg-5)] transition-transform"
                    :class="collapsed.has(mod.key) ? '' : 'rotate-90'" />
                  <span class="font-medium text-[var(--c-fg-2)]">{{ mod.model }}</span>
                  <span class="text-[11px] text-[var(--c-fg-6)]">{{ mod.rows.length }} 档</span>
                </div>
              </td>
            </tr>
            <!-- PLACEHOLDER_ROWS -->
            <template v-if="!collapsed.has(mod.key)">
              <template v-for="e in mod.rows" :key="e.id">
                <!-- 展示行 -->
                <tr v-if="editingId !== e.id" class="group border-t border-[var(--c-border-2)] hover:bg-[var(--c-surface-2)]">
                  <td class="py-2 pl-[3.25rem] pr-4 text-[12px] text-[var(--c-fg-4)]">{{ e.category }}</td>
                  <td class="px-4 py-2">
                    <span v-if="e.price_mode" class="rounded-[2px] bg-primary-50 px-1.5 py-0.5 text-[11px] text-primary-700">{{ PRICE_MODE_LABEL[e.price_mode] || e.price_mode }}</span>
                    <span v-else class="text-[var(--c-fg-6)]">—</span>
                  </td>
                  <td v-if="isVideo" class="px-4 py-2 font-mono text-[12px]">{{ e.resolution || '—' }}</td>
                  <td v-if="isVideo" class="px-4 py-2 text-right font-mono tabular-nums">{{ e.duration_s != null ? `${e.duration_s}s` : '—' }}</td>
                  <td class="px-4 py-2 text-right font-mono tabular-nums">
                    {{ e.cost_cny.toFixed(3) }}<span v-if="isMetered(e)" class="ml-0.5 text-[10px] text-[var(--c-fg-6)]">/M</span>
                  </td>
                  <td class="px-4 py-2 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ isMetered(e) ? '—' : newPriceOf(e).toFixed(3) }}</td>
                  <td class="px-4 py-2 text-right font-mono tabular-nums text-[var(--c-fg-4)]">{{ isMetered(e) ? '—' : newPointsOf(e) }}</td>
                  <td class="px-4 py-2 text-right font-mono font-semibold tabular-nums text-primary-600">{{ e.points != null ? e.points : '—' }}</td>
                  <td class="px-4 py-2 max-w-[220px] text-[11px] text-[var(--c-fg-5)]">{{ e.note || '—' }}</td>
                  <td class="px-4 py-2 text-right">
                    <div class="flex justify-end gap-2 opacity-0 transition group-hover:opacity-100">
                      <button type="button" class="link-action" @click="startEdit(e)">编辑</button>
                      <button type="button" class="link-danger" @click="emit('delete', e)">删除</button>
                    </div>
                  </td>
                </tr>
                <!-- 编辑行 -->
                <tr v-else class="border-t border-primary-200 bg-primary-50/40">
                  <td class="py-2 pl-[3.25rem] pr-4">
                    <input v-model="buf.category" class="w-full rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td class="px-4 py-2">
                    <select v-model="buf.price_mode" class="w-full rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1 py-1 text-[12px] outline-none focus:border-primary-400">
                      <option :value="null">—</option>
                      <option value="per_call">按次</option>
                      <option value="per_mtoken">按量</option>
                      <option value="per_second">按秒</option>
                    </select>
                  </td>
                  <td v-if="isVideo" class="px-4 py-2">
                    <input v-model="buf.resolution" placeholder="如 1080P" class="w-20 rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 font-mono text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td v-if="isVideo" class="px-4 py-2 text-right">
                    <input v-model.number="buf.duration_s" type="number" step="1" min="0" class="w-16 rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 text-right font-mono text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td class="px-4 py-2 text-right">
                    <input v-model.number="buf.cost_cny" type="number" step="0.001" min="0" class="w-20 rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 text-right font-mono text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td class="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-[var(--c-fg-5)]">{{ buf.price_mode === 'per_mtoken' ? '—' : ((Number(buf.cost_cny) || 0) * 1.3).toFixed(3) }}</td>
                  <td class="px-4 py-2 text-right font-mono text-[11px] tabular-nums text-[var(--c-fg-5)]">{{ buf.price_mode === 'per_mtoken' ? '—' : Math.round((Number(buf.cost_cny) || 0) * 1.3 * 15) }}</td>
                  <td class="px-4 py-2 text-right">
                    <input v-model.number="buf.points" type="number" step="1" min="0" placeholder="自动" class="w-16 rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 text-right font-mono text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td class="px-4 py-2">
                    <input v-model="buf.note" placeholder="备注/公式" class="w-full rounded-[3px] border border-[var(--c-border)] bg-[var(--c-surface)] px-1.5 py-1 text-[12px] outline-none focus:border-primary-400" />
                  </td>
                  <td class="px-4 py-2 text-right">
                    <div class="flex justify-end gap-2">
                      <button type="button" class="link-action" @click="saveEdit(e.id)">保存</button>
                      <button type="button" class="link-muted" @click="cancelEdit">取消</button>
                    </div>
                  </td>
                </tr>
              </template>
            </template>
          </template>
        </template>
      </tbody>
    </table>
  </div>
</template>
