import { requestEmailRegistration } from '~~/server/utils/registration'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email?: string; password?: string; invite?: string }>(event)
  await requestEmailRegistration(event, {
    email: body?.email,
    password: body?.password,
    invite: body?.invite,
  })
  return { ok: true }
})
