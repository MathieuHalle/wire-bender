import { capSocketPayload } from '../utils/liveMessage'

// The live socket's frame cap (spec §13): set on the h3 app before Nitro makes its socket
// server from it, so ws refuses an oversized frame without buffering it.
export default defineNitroPlugin((nitroApp) => {
  capSocketPayload(nitroApp.h3App as unknown as Parameters<typeof capSocketPayload>[0])
})
