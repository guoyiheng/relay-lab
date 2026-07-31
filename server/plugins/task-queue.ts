/// <reference types="@cloudflare/workers-types" />
import { handleTaskMessage, type TaskMessage } from '~~/server/utils/taskrunner'

// Cloudflare Queues 消费者：驱动任务的「提交 → 单次轮询 → 未终态重新入队」循环。
// Nitro cloudflare_module 预设在 Worker 收到 queue 事件时触发 cloudflare:queue 钩子，
// payload.batch 是标准 MessageBatch。我们对每条消息处理一步，未终态则用 producer
// 重新 send 一条带 delaySeconds 的后续消息（不用 msg.retry —— retry 会耗尽 max_retries；
// 轮询是「计划下一步」而非「重试失败」，语义上应重新入队）。处理成功即 ack。
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('cloudflare:queue', async ({ batch, env }: { batch: MessageBatch<TaskMessage>; env: any }) => {
    const queue = env?.TASK_QUEUE as Queue<TaskMessage> | undefined
    for (const message of batch.messages) {
      try {
        const result = await handleTaskMessage(message.body)
        if (result && queue) {
          await queue.send(result.next, { delaySeconds: result.delaySeconds })
        }
        message.ack()
      } catch (err) {
        console.error('[task-queue] message failed:', err)
        // 交给队列重试（瞬时错误）；超过 max_retries 进死信队列，不会无限循环。
        message.retry()
      }
    }
  })
})
