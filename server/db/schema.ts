import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const REVISION_HOW = ['create', 'import', 'edit', 'api', 'undo', 'redo', 'restore', 'recovered', 'fork'] as const
export type RevisionHow = typeof REVISION_HOW[number]

export const BOARD_VISIBILITY = ['view', 'edit', 'private'] as const
export type BoardVisibility = typeof BOARD_VISIBILITY[number]

export const boards = sqliteTable('boards', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** JSON BoardFile */
  current: text('current').notNull(),
  head: integer('head').notNull(),
  ownerId: text('owner_id').notNull().default('local'),
  linkId: text('link_id').notNull(),
  visibility: text('visibility', { enum: BOARD_VISIBILITY }).notNull().default('view'),
  passwordHash: text('password_hash'),
  trashedAt: integer('trashed_at'),
  /** The board this one was forked from. */
  forkedFrom: text('forked_from'),
  /**
   * The source's link id the fork was made through (null for a duplicate of one's own
   * board). `forkedFrom` shows it only while the source's link is still this one (R12).
   */
  forkedFromLink: text('forked_from_link')
}, t => [
  uniqueIndex('boards_link_id_unique').on(t.linkId)
])

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
  board: text('board').notNull(),
  authorId: text('author_id'),
  /** The API token a revision was made with, if any. */
  tokenId: text('token_id'),
  /** 1 for a revision that came in with an imported bundle (its author is only a name). */
  imported: integer('imported').notNull().default(0)
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

export const IDENTITY_PROVIDERS = ['github', 'google'] as const

export const users = sqliteTable('users', {
  /** A uuid; `'local'` for the local user. */
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  avatar: text('avatar'),
  isAdmin: integer('is_admin').notNull().default(0),
  isPremium: integer('is_premium').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  suspendedAt: integer('suspended_at'),
  deletedAt: integer('deleted_at')
})

export const identities = sqliteTable('identities', {
  provider: text('provider', { enum: IDENTITY_PROVIDERS }).notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull()
}, t => [
  primaryKey({ columns: [t.provider, t.providerId] })
])

/** One row at most. */
export const setup = sqliteTable('setup', {
  codeHash: text('code_hash'),
  doneAt: integer('done_at')
})

export const linkVisits = sqliteTable('link_visits', {
  userId: text('user_id').notNull(),
  boardId: text('board_id').notNull(),
  linkId: text('link_id').notNull(),
  lastOpened: integer('last_opened').notNull()
}, t => [
  primaryKey({ columns: [t.userId, t.boardId] })
])

/** Personal API tokens. Only the sha256 of a token is stored. */
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  /** Hex sha256 of the whole token string. */
  hash: text('hash').notNull().unique(),
  /** The first 8 characters after `wb_`, for display. */
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at')
}, t => [
  index('tokens_user_idx').on(t.userId)
])
