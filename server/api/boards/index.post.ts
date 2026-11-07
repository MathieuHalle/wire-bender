import { createOrImport } from '../../utils/api'
import { useDb } from '../../db'
import { authorOf, bodyText, sendResult } from '../../utils/sendResult'

export default defineEventHandler(async event => sendResult(event, createOrImport(useDb(), await bodyText(event), authorOf(event))))
