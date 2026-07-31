#!/usr/bin/env node
/**
 * 生成创建登录用户的 D1 INSERT 语句（哈希格式与 server/utils/db.ts 的 hashPassword 一致：
 * scryptSync(password, salt, 64) → "salt:hex"，可被 verifyPassword 校验）。
 *
 *   node scripts/create-user.mjs <用户名> <密码>
 *   # 直接应用到远端 D1：
 *   node scripts/create-user.mjs admin 's3cret' | npx wrangler d1 execute relay-lab --remote --file=/dev/stdin
 */
import { scryptSync, randomBytes } from 'node:crypto'

const [username, password] = process.argv.slice(2)
if (!username || !password) {
  console.error('用法: node scripts/create-user.mjs <用户名> <密码>')
  process.exit(1)
}
const salt = randomBytes(16).toString('hex')
const hash = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
const now = Date.now()
const esc = (s) => String(s).replace(/'/g, "''")
// INSERT OR IGNORE：同名用户已存在则跳过（不覆盖密码）。
process.stdout.write(
  `INSERT OR IGNORE INTO users (username, password_hash, created_at, updated_at) ` +
  `VALUES ('${esc(username)}', '${esc(hash)}', ${now}, ${now});\n`,
)
