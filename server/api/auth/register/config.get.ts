import { inviteIsValid } from '~~/server/utils/registration'

export default defineEventHandler((event) => {
  const query = getQuery(event)
  return { allowed: inviteIsValid(query.invite) }
})
