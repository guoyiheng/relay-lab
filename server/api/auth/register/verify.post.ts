import { verifyEmailRegistration } from '~~/server/utils/registration'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ token?: string }>(event)
  return verifyEmailRegistration(event, body?.token)
})
