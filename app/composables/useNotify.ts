/**
 * 全局轻提示（右上角 toast）——薄封装 Nuxt UI 的 useToast，统一替代原生 alert。
 * 成功/失败/普通三种语义，图标与状态色固定，调用点只管传文案。
 *
 *   const notify = useNotify()
 *   notify.success('已保存')
 *   notify.error(err?.statusMessage || '保存失败')
 *
 * 容器 <UApp> 在 app.vue，toaster 定位右上角。
 */
export function useNotify() {
  const toast = useToast()
  return {
    /** 成功：绿色 + 勾。 */
    success(title: string, description?: string) {
      toast.add({ title, description, color: 'success', icon: 'i-carbon-checkmark-outline' })
    },
    /** 失败：红色 + 警告。error 语义色对应删除/失败。 */
    error(title: string, description?: string) {
      toast.add({ title, description, color: 'error', icon: 'i-carbon-warning-alt' })
    },
    /** 普通信息：中性色。 */
    info(title: string, description?: string) {
      toast.add({ title, description, color: 'neutral', icon: 'i-carbon-information' })
    },
  }
}
