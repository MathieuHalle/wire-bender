import { boardPath, watchBoard } from '../../utils/boardFile'

export default defineEventHandler(async (event) => {
  const stream = createEventStream(event)
  const stop = watchBoard(boardPath(), (revision) => {
    stream.push({
      event: 'revision',
      data: JSON.stringify(revision === null ? { errors: true } : { revision })
    }).catch(() => {})
  })
  stream.onClosed(async () => {
    stop()
    await stream.close()
  })
  return stream.send()
})
