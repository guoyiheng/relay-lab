// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  // Nuxt 4 目录结构：前端代码在 app/（srcDir 自动指向它），server/ 留根。
  // compatibilityVersion 让 Nuxt 3.12+ 提前启用 v4 行为，便于平滑升级。
  future: { compatibilityVersion: 4 },
  // ⚠️ 必须 >= 2025-07-15：Nitro 的 cloudflare dev 预设（跑 getPlatformProxy 注入
  // 真实 D1/R2 binding 到 globalThis.__env__）按此日期做前置过滤，低于它 dev 下
  // 预设解析为 undefined → binding 插件不加载 → 请求里拿不到 DB。改小会复现该报错。
  compatibilityDate: '2025-07-15',
  devtools: { enabled: false },
  // 生产走 cloudflare_module 预设打成单个 Worker；本地 nuxt dev 用 Nitro 内置的
  // Cloudflare dev 模拟（读 wrangler.jsonc 的 binding）。wrangler.jsonc 里 D1/R2
  // 都开了 remote，故本地 dev 直连线上 D1/R2，数据与线上一致。
  modules: ['@nuxt/ui', '@pinia/nuxt'],
  vite: {
    optimizeDeps: {
      include: ['fflate', 'highlight.js/lib/common', 'marked'],
    },
  },
  css: ['~/assets/css/main.css'],
  // Nuxt UI v4：自定义色板（@theme 里定义的 --color-wfblue-*）必须在此白名单声明，
  // 否则 @nuxt/ui 不会为 primary 生成 --ui-color-primary-* 语义变量，
  // 导致 text-primary-500 / color="primary" 全部失效。默认白名单只含内置色板。
  ui: {
    theme: {
      colors: ['primary', 'secondary', 'success', 'info', 'warning', 'error', 'neutral', 'wfblue'],
    },
  },
  icon: {
    serverBundle: { collections: ['carbon'] },
    clientBundle: { scan: true },
  },
  colorMode: {
    preference: 'light',
    fallback: 'light',
    classSuffix: '',
  },
  app: {
    head: {
      title: 'Relay Lab · 中转实验室',
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      ],
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: '为多家中转 API 提供生图与生视频接口的统一测试台' },
      ],
    },
  },
  nitro: {
    // 部署目标：单个 Cloudflare Worker（SSR + 所有 /api）。binding 见 wrangler.jsonc。
    preset: 'cloudflare_module',
    cloudflare: {
      // 让 Nitro/Miniflare 读取根目录 wrangler.jsonc 的 binding 与兼容性配置。
      // dev 时经 wrangler getPlatformProxy 直连线上 D1/R2（wrangler.jsonc 里 remote:true），
      // 把 binding 挂到 globalThis.__env__，本地数据与线上一致。需 CLOUDFLARE_API_TOKEN。
      deployConfig: true,
      nodeCompat: true,
      dev: {},
    },
    storage: {},
  },
})
