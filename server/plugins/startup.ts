import { useDb } from '../db'
import { checkMode } from '../utils/access'

// The mode is checked before the database is opened: a wrong mode creates nothing.
export default defineNitroPlugin(() => {
  checkMode(process.env)
  useDb()
})
