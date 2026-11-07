import { THIS_COMPUTER } from '../../utils/access'

/** The device this request is from: its name in the presence list. */
export default defineEventHandler((event) => {
  const device = event.context.device as { id: string, name: string } | undefined
  return { name: device?.name ?? THIS_COMPUTER, paired: device !== undefined }
})
