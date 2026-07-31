/**
 * 离线模式的 IndexedDB 封装（极简 Promise 包装，无三方依赖）。
 *
 * 库 relay-lab-offline，对应在线的 D1 + R2：
 *   · providers / models / tasks —— 自增数字主键，对齐在线数字 id
 *   · assets                     —— 字符串主键（asset id），存元数据
 *   · blobs                      —— 按 sha256 存字节(base64)，参考素材/生成结果去重
 *
 * 只在浏览器可用；SSR 侧调用方需自行短路（离线模式本就是 client-only）。
 */

export const DB_NAME = 'relay-lab-offline'
export const DB_VERSION = 1

export type StoreName = 'providers' | 'models' | 'tasks' | 'assets' | 'blobs'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB 不可用（仅浏览器环境支持离线模式）'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('providers')) {
        db.createObjectStore('providers', { keyPath: 'id', autoIncrement: true })
      }
      if (!db.objectStoreNames.contains('models')) {
        const s = db.createObjectStore('models', { keyPath: 'id', autoIncrement: true })
        s.createIndex('provider_id', 'provider_id', { unique: false })
      }
      if (!db.objectStoreNames.contains('tasks')) {
        const s = db.createObjectStore('tasks', { keyPath: 'id', autoIncrement: true })
        s.createIndex('created_at', 'created_at', { unique: false })
      }
      if (!db.objectStoreNames.contains('assets')) {
        const s = db.createObjectStore('assets', { keyPath: 'id' })
        s.createIndex('sha256', 'sha256', { unique: false })
        s.createIndex('kind', 'kind', { unique: false })
      }
      if (!db.objectStoreNames.contains('blobs')) {
        db.createObjectStore('blobs', { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    let result!: T
    req.onsuccess = () => { result = req.result }
    req.onerror = () => reject(req.error)
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error || req.error)
    t.onabort = () => reject(t.error || new Error('IndexedDB 事务已中止'))
  }))
}

// ── 通用 CRUD ──────────────────────────────────────────────────────
export const idb = {
  getAll<T>(store: StoreName): Promise<T[]> {
    return tx<T[]>(store, 'readonly', (s) => s.getAll())
  },
  get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    return tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
  },
  // put 返回主键（自增 store 用于拿新 id）。
  put<T = any>(store: StoreName, value: T): Promise<IDBValidKey> {
    return tx<IDBValidKey>(store, 'readwrite', (s) => s.put(value as any))
  },
  add<T = any>(store: StoreName, value: T): Promise<IDBValidKey> {
    return tx<IDBValidKey>(store, 'readwrite', (s) => s.add(value as any))
  },
  delete(store: StoreName, key: IDBValidKey): Promise<void> {
    return tx<undefined>(store, 'readwrite', (s) => s.delete(key) as IDBRequest<undefined>).then(() => undefined)
  },
  // 按索引取一批（如 models by provider_id）。
  getAllByIndex<T>(store: StoreName, index: string, value: IDBValidKey): Promise<T[]> {
    return openDb().then((db) => new Promise<T[]>((resolve, reject) => {
      const t = db.transaction(store, 'readonly')
      const req = t.objectStore(store).index(index).getAll(value)
      req.onsuccess = () => resolve(req.result as T[])
      req.onerror = () => reject(req.error)
    }))
  },
}
