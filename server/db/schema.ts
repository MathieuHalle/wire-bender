import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const REVISION_HOW = ['create', 'import', 'edit', 'api', 'undo', 'redo', 'restore', 'recovered'] as const
export type RevisionHow = typeof REVISION_HOW[number]

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** JSON BoardFile */
  current: text('current').notNull(),
  head: integer('head').notNull()
})

export const revisions = sqliteTable('revisions', {
  boardId: text('board_id').notNull(),
  n: integer('n').notNull(),
  createdAt: integer('created_at').notNull(),
  /** Display name, e.g. "Local · iPad". */
  author: text('author').notNull(),
  how: text('how', { enum: REVISION_HOW }).notNull(),
  /** The revision an undo, redo or restore refers to. */
  target: integer('target'),
  summary: text('summary').notNull(),
  /** JSON BoardFile */
  board: text('board').notNull()
}, t => [
  primaryKey({ columns: [t.boardId, t.n] }),
  index('revisions_board_idx').on(t.boardId)
])

export const devices = sqliteTable('devices', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeen: integer('last_seen').notNull()
})
