<script setup lang="ts">
// 兼容旧注册链接：统一进入登录页的注册 Tab，并保留邀请码参数。
definePageMeta({ layout: 'auth' })

const route = useRoute()
await navigateTo({
  path: '/login',
  query: { ...route.query, tab: 'register' },
}, { replace: true })
</script>
