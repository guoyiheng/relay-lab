<!-- 应用根：UApp 提供 toast/overlay 容器（toaster 右上角），再套布局与路由页。 -->
<!-- 确认弹窗通过 useConfirm() → useOverlay() 由 UApp 的 overlay 栈按需挂载，无需常驻。 -->
<template>
  <UApp :toaster="{ position: 'top-right' }">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <DownloadProgress />
  </UApp>
</template>
