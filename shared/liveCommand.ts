// Undo and redo over the live socket: a y-websocket message of this type, holding a
// `varString` of JSON. The client sends a LiveCommand; the server answers with a
// LiveAnswer of the same id, after the same socket's earlier updates.

/** The message type of a command and of its answer. */
export const MESSAGE_COMMAND = 3

export type LiveOp = 'undo' | 'redo'
export interface LiveCommand { op: LiveOp, id: number }
export interface LiveAnswer { id: number, ok: boolean, reason?: string }
