import { throttledNotify } from '../utils/throttle'

// One throttle for the whole page: the tools and the live board both warn when the board
// is offline, and a click should not raise one toast from each.
let show: ((message: string) => void) | null = null
const warn = throttledNotify(m => show?.(m))

/** A warning toast, throttled (see `throttledNotify`). Call in setup. */
export function useWarning(): (message: string) => void {
  const toast = useToast()
  show = m => toast.add({ title: m, color: 'warning', icon: 'i-lucide-ban' })
  return warn
}
