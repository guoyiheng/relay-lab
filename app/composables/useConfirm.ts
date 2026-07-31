import ConfirmDialog from '~/components/ConfirmDialog.vue'

/**
 * 全局确认弹窗——把原生同步 confirm() 换成返回 Promise<boolean> 的居中 Modal。
 *
 *   const confirm = useConfirm()
 *   if (!(await confirm({ title: '删除「X」？', description: '此操作不可恢复' }))) return
 *
 * 走 Nuxt UI v4 的 useOverlay()：每次调用挂到 UApp 的 overlay 栈里，与其他 Modal
 * 隔离（不会被外层 UModal 的 modal=true focus trap 屏蔽）。危险操作（删除）传
 * danger: true，确认按钮走 error 色。
 */
export interface ConfirmOptions {
  title: string
  description?: string
  confirmText?: string
  cancelText?: string
  /** 危险操作：确认按钮用 error 色。删除类默认应传 true。 */
  danger?: boolean
}

export function useConfirm() {
  const overlay = useOverlay()
  return async function confirm(opts: ConfirmOptions): Promise<boolean> {
    const instance = overlay.create(ConfirmDialog, {
      props: opts,
      destroyOnClose: true,
    })
    const result = await instance.open()
    return result === true
  }
}
