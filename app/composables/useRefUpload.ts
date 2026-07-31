// 参考素材上传的通用方法（抽离自 pages/index.vue 的提交逻辑）。
// 约定：素材一律「先上传到 R2 拿到 asset id，再用 id 发起任务」，全程不走 base64。
//   · 已有 asset id（本地已传 / 生成素材直接引用）→ 原样返回，零网络
//   · pending 本地文件（File）→ POST /api/uploads（multipart），服务端 sha256 去重
//   · pending 远端 URL（拖入的生成结果等）→ POST /api/uploads/import，
//     若是我方 R2 对象则秒级复用其 asset 行，不重新下载
// 返回真实 asset id 列表，顺序与入参一致；单个失败跳过而非整体中断。

export interface RefUploadItem {
  id: string                // asset id；'' 表示尚未落库（pending）
  kind: 'image' | 'video' | 'audio'
  public_url?: string       // pending 远端 URL 导入用
  file?: File               // pending 本地文件上传用
}

/** 把一批参考素材解析成 asset id 数组（在任务提交前调用）。委托给 DataSource（离线/在线一致）。 */
export function uploadRefsToAssetIds(items: RefUploadItem[]): Promise<string[]> {
  return useDataSource().resolveRefIds(items)
}
