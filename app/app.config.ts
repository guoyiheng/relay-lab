// Nuxt UI v4 主题色配置。色阶（wfblue）在 app/assets/css/main.css 的 @theme 定义，
// 这里只把语义角色映射到色板：primary=wfblue、neutral=slate。状态色沿用 UI 默认（error/success）。
// 注：v4 里 primary/neutral 归在 appConfig.ui.colors（本文件），不是 nuxt.config 的模块选项。
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'wfblue',
      neutral: 'slate',
    },
    // 输入类组件根节点默认 inline-flex（收缩到内容宽度），导致设了 w-full 也不撑满。
    // 全局把 root 改为 w-full，让表单里所有输入框自适应撑满容器（#7）。
    input: { slots: { root: 'w-full' } },
    textarea: { slots: { root: 'w-full' } },
    inputNumber: { slots: { root: 'w-full' } },
    inputMenu: { slots: { root: 'w-full' } },
  },
})
