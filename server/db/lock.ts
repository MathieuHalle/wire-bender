// One server per data folder: `<data>/wirebender.lock` holds `<pid>:<thread>` of its owner.
//
// A lock whose process is gone is stale and taken over. A lock held by another thread of
// this same process is taken over too: `nuxt dev` starts the new server worker thread
// before the old one has finished shutting down. A lock holding our own token that this
// process does not hold is stale as well: in Docker, node is pid 1 (thread 0) on every
// start, so a container killed without running the exit hook leaves exactly our token.
// Only a lock still holding our own token is ever removed, so an old worker never deletes
// its successor's lock.
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { threadId } from 'node:worker_threads'

export const LOCK_FILE = 'wirebender.lock'

const token = `${process.pid}:${threadId}`
const held = new Set<string>()
let exitHook = false

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function readOwner(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return null
  }
}

/** True when the owner recorded in a lock may still be using the folder. */
function inUse(owner: string, file: string): boolean {
  if (owner === token) return held.has(file)
  const pid = Number(owner.split(':')[0])
  if (!Number.isInteger(pid) || pid <= 0) return false
  return pid !== process.pid && alive(pid)
}

/** Take the data folder's lock, or throw naming the folder. Returns the release function. */
export function lockDataDir(dataDir: string): () => void {
  const file = path.resolve(dataDir, LOCK_FILE)
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, `${token}\n`, { flag: 'wx' })
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || attempt > 0) throw e
      const owner = readOwner(file)
      if (owner !== null && inUse(owner, file)) {
        throw new Error(`another WireBender server (pid ${owner.split(':')[0]}) is using the data folder ${path.resolve(dataDir)}. Stop it, or set WIREBENDER_DATA to another folder.`, { cause: e })
      }
      try {
        unlinkSync(file)
      } catch {
        // Someone else removed it first; the next attempt decides.
      }
    }
  }
  held.add(file)
  if (!exitHook) {
    exitHook = true
    process.once('exit', () => {
      for (const f of held) release(f)
    })
  }
  return () => release(file)
}

function release(file: string): void {
  if (!held.delete(file)) return
  if (readOwner(file) !== token) return
  try {
    unlinkSync(file)
  } catch {
    // Already gone.
  }
}
