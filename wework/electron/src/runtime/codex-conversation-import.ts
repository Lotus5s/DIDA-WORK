import { createReadStream, createWriteStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Transform } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'

/**
 * Import conversations from the user's own Codex installation into DIDA Work.
 *
 * The import is copy-only: the legacy Codex home is never written to. Each
 * conversation is stored in DIDA Work's isolated Codex home as a self-contained
 * rollout (fork/base markers removed), and the turns/items that Codex already
 * projected into `thread_history_1.sqlite` are copied across so the transcript
 * renders without asking Codex to rebuild the lineage.
 *
 * The import runs once, on the next application start, because the runtime-work
 * index and the history database must not be written while the executor and
 * Codex app-server are using them.
 */

const REQUEST_FILE = 'codex-conversation-import-request.json'
const STATUS_FILE = 'codex-conversation-import-status.json'
const LINEAGE_KEYS = ['forked_from_id', 'forked_from_ordinal_exclusive', 'history_base']
const HISTORY_TABLES = [
  'thread_turns',
  'thread_items',
  'thread_history_projection_state',
  'thread_realtime_items',
]
const FIRST_LINE_LIMIT = 4 * 1024 * 1024

export type CodexImportMode = 'skip' | 'overwrite'

export interface CodexImportRequest {
  requestedAt: string
  legacyHome: string
  mode: CodexImportMode
}

export interface CodexImportStatus {
  completedAt: string
  legacyHome: string
  mode: CodexImportMode
  newConversations: number
  overwritten: number
  skipped: number
  totalCandidates: number
  error?: string
}

export interface CodexImportScan {
  available: boolean
  legacyHome: string
  total: number
  newCount: number
  duplicateCount: number
  error?: string
}

interface LegacyThread {
  id: string
  path: string
  size: number
  threadSource: string
  originator: string
  timestamp: string | null
  cwd: string | null
  ephemeral: boolean
}

function zstdStream(): Transform {
  const factory = (createZstdDecompress as unknown) as () => Transform
  return factory()
}

function normalizePath(value: string | null | undefined): string {
  if (!value) return ''
  const normalized = value.replace(/\\/g, '/')
  const drive = normalized.length >= 2 && normalized[1] === ':' ? normalized[0].toUpperCase() : ''
  return (drive ? drive + normalized.slice(1) : normalized).replace(/\/+$/, '')
}

async function readFirstLine(path: string): Promise<string | null> {
  const raw = createReadStream(path)
  const stream = path.endsWith('.zst') ? raw.pipe(zstdStream()) : raw
  try {
    let buffer = Buffer.alloc(0)
    for await (const chunk of stream) {
      buffer = Buffer.concat([buffer, chunk as Buffer])
      const newline = buffer.indexOf(10)
      if (newline >= 0) return buffer.subarray(0, newline).toString('utf8')
      if (buffer.length > FIRST_LINE_LIMIT) break
    }
    return buffer.length > 0 ? buffer.toString('utf8') : null
  } finally {
    stream.destroy()
    raw.destroy()
  }
}

async function recordFiles(directory: string): Promise<string[]> {
  const found: string[] = []
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      found.push(...(await recordFiles(path)))
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      (entry.name.endsWith('.jsonl') || entry.name.endsWith('.jsonl.zst'))
    ) {
      found.push(path)
    }
  }
  return found
}

async function scanLegacyThreads(legacyHome: string): Promise<LegacyThread[]> {
  const sessions = join(legacyHome, 'sessions')
  const files = await recordFiles(sessions)
  const threads = new Map<string, LegacyThread>()
  for (const path of files) {
    let payload: Record<string, unknown> | null = null
    try {
      const line = await readFirstLine(path)
      if (!line) continue
      payload = (JSON.parse(line) as { payload?: Record<string, unknown> }).payload ?? null
    } catch {
      continue
    }
    const id = typeof payload?.id === 'string' ? payload.id : typeof payload?.session_id === 'string' ? payload.session_id : ''
    if (!id) continue
    const size = (await fs.stat(path)).size
    const candidate: LegacyThread = {
      id,
      path,
      size,
      threadSource: typeof payload?.thread_source === 'string' ? payload.thread_source : '',
      originator: typeof payload?.originator === 'string' ? payload.originator : '',
      timestamp: typeof payload?.timestamp === 'string' ? payload.timestamp : null,
      cwd: typeof payload?.cwd === 'string' ? payload.cwd : null,
      ephemeral: payload?.ephemeral === true,
    }
    const previous = threads.get(id)
    if (!previous || preference(candidate) > preference(previous)) {
      threads.set(id, candidate)
    }
  }
  return [...threads.values()]
}

function preference(thread: LegacyThread): number {
  const plain = thread.path.endsWith('.jsonl') ? 1 : 0
  const canonical = basename(thread.path).slice(0, -'.jsonl'.length).endsWith(thread.id) ? 2 : 0
  return canonical * 1000 + plain * 100 + Math.min(thread.size, 1_000_000) / 1_000_000
}

function importable(thread: LegacyThread): boolean {
  return (
    thread.threadSource === 'user' &&
    thread.originator !== 'codex_exec' &&
    !thread.ephemeral &&
    thread.path !== ''
  )
}

async function readSessionNames(legacyHome: string): Promise<Map<string, { name: string; updatedAt: string }>> {
  const names = new Map<string, { name: string; updatedAt: string }>()
  let content: string
  try {
    content = await fs.readFile(join(legacyHome, 'session_index.jsonl'), 'utf8')
  } catch {
    return names
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string }
      if (record.id) {
        names.set(record.id, {
          name: (record.thread_name ?? '').trim(),
          updatedAt: record.updated_at ?? '',
        })
      }
    } catch {
      // Ignore malformed index lines.
    }
  }
  return names
}

async function readRuntimeThreadIds(executorHome: string): Promise<Set<string>> {
  const ids = new Set<string>()
  try {
    const content = await fs.readFile(join(executorHome, 'runtime-work', 'index.json'), 'utf8')
    const index = JSON.parse(content) as { tasks?: Record<string, { thread_id?: string }> }
    for (const task of Object.values(index.tasks ?? {})) {
      if (task?.thread_id) ids.add(task.thread_id)
    }
  } catch {
    // No runtime index yet: every thread is new.
  }
  return ids
}

export function legacyCodexHome(homeDirectory: string): string {
  return process.env.CODEX_HOME?.trim() || join(homeDirectory, '.codex')
}

export async function scanCodexConversations(options: {
  legacyHome: string
  executorHome: string
}): Promise<CodexImportScan> {
  try {
    const threads = (await scanLegacyThreads(options.legacyHome)).filter(importable)
    if (threads.length === 0) {
      return {
        available: false,
        legacyHome: options.legacyHome,
        total: 0,
        newCount: 0,
        duplicateCount: 0,
      }
    }
    const existing = await readRuntimeThreadIds(options.executorHome)
    const duplicateCount = threads.filter(thread => existing.has(thread.id)).length
    return {
      available: true,
      legacyHome: options.legacyHome,
      total: threads.length,
      newCount: threads.length - duplicateCount,
      duplicateCount,
    }
  } catch (error) {
    return {
      available: false,
      legacyHome: options.legacyHome,
      total: 0,
      newCount: 0,
      duplicateCount: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function copyRollout(source: string, destination: string): Promise<number> {
  await fs.mkdir(join(destination, '..'), { recursive: true })
  const raw = createReadStream(source)
  const stream = source.endsWith('.zst') ? raw.pipe(zstdStream()) : raw
  const iterator = stream[Symbol.asyncIterator]()
  let buffer = Buffer.alloc(0)
  let firstLine: string | null = null
  while (!firstLine) {
    const next = await iterator.next()
    if (next.done) break
    buffer = Buffer.concat([buffer, next.value as Buffer])
    const newline = buffer.indexOf(10)
    if (newline >= 0) {
      firstLine = buffer.subarray(0, newline).toString('utf8')
      buffer = buffer.subarray(newline + 1)
      break
    }
  }
  if (!firstLine) {
    stream.destroy()
    raw.destroy()
    throw new Error(`rollout has no session metadata: ${source}`)
  }
  const record = JSON.parse(firstLine) as { payload?: Record<string, unknown> }
  if (record.payload) {
    for (const key of LINEAGE_KEYS) delete record.payload[key]
  }
  const output = createWriteStream(destination)
  output.write(Buffer.from(`${JSON.stringify(record)}\n`, 'utf8'))
  if (buffer.length > 0) output.write(buffer)
  for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
    if (!output.write(chunk as Buffer)) {
      await new Promise<void>(resolve => {
        output.once('drain', () => resolve())
      })
    }
  }
  output.end()
  await finished(output)
  return (await fs.stat(destination)).size
}

function copyHistoryRows(databasePath: string, legacyDatabasePath: string, threadIds: string[]): number {
  if (threadIds.length === 0) return 0
  let database: DatabaseSync
  try {
    database = new DatabaseSync(databasePath)
  } catch {
    return 0
  }
  try {
    const escaped = legacyDatabasePath.replace(/'/g, "''")
    database.exec(`ATTACH DATABASE '${escaped}' AS old`)
  } catch {
    database.close()
    return 0
  }
  let copied = 0
  try {
    const statements = HISTORY_TABLES.map(table =>
      database.prepare(
        `INSERT OR REPLACE INTO ${table} SELECT * FROM old.${table} WHERE thread_id = ?`
      )
    )
    database.exec('BEGIN')
    for (const threadId of threadIds) {
      for (const statement of statements) {
        const result = statement.run(threadId)
        if (typeof result.changes === 'number') copied += result.changes
      }
    }
    database.exec('COMMIT')
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // The transaction may already be closed.
    }
    throw error
  } finally {
    database.close()
  }
  return copied
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function taskTemplate(tasks: Record<string, Record<string, unknown>>): Record<string, unknown> | null {
  for (const task of Object.values(tasks)) {
    const handle = task?.runtime_handle as Record<string, unknown> | undefined
    if (handle?.executionRequest && typeof handle.executionRequest === 'object') {
      return task
    }
  }
  return null
}

function buildTask(
  template: Record<string, unknown>,
  thread: LegacyThread,
  title: string,
  createdAt: number,
  updatedAt: number
): Record<string, unknown> {
  const task = structuredClone(template)
  const workspace = normalizePath(thread.cwd)
  const localTaskId = `runtime-import-${thread.id.slice(0, 10)}`
  task.local_task_id = localTaskId
  task.thread_id = thread.id
  task.title = title
  task.workspace_path = workspace
  task.created_at = createdAt
  task.updated_at = updatedAt
  task.recency_at = updatedAt
  task.runtime_workspace_roots = workspace ? [workspace] : []
  const handle = task.runtime_handle as Record<string, unknown>
  const request = handle.executionRequest as Record<string, unknown>
  request.project_workspace_path = workspace
  request.runtime_workspace_roots = workspace ? [workspace] : []
  request.workspace_source = 'local_path'
  request.new_session = false
  request.history = []
  request.prompt = ''
  handle.lastTurnId = null
  handle.userMessagePresentations = []
  return task
}

export async function importCodexConversations(options: {
  legacyHome: string
  executorHome: string
  mode: CodexImportMode
  log?: (message: string) => void
}): Promise<Omit<CodexImportStatus, 'completedAt' | 'legacyHome' | 'mode'>> {
  const log = options.log ?? (() => undefined)
  const destinationCodexHome = join(options.executorHome, 'codex')
  const destinationSessions = join(destinationCodexHome, 'sessions')
  const destinationDatabase = join(destinationCodexHome, 'thread_history_1.sqlite')
  const legacyDatabase = join(options.legacyHome, 'thread_history_1.sqlite')
  const runtimeIndexPath = join(options.executorHome, 'runtime-work', 'index.json')

  const threads = (await scanLegacyThreads(options.legacyHome)).filter(importable)
  const indexPath = runtimeIndexPath
  let runtime: { tasks?: Record<string, Record<string, unknown>>; [key: string]: unknown }
  try {
    runtime = JSON.parse(await fs.readFile(indexPath, 'utf8'))
  } catch {
    throw new Error('DIDA Work 还没有任务数据，请先新建一个任务再导入')
  }
  const tasks = (runtime.tasks ?? {}) as Record<string, Record<string, unknown>>
  const template = taskTemplate(tasks)
  if (!template) {
    throw new Error('DIDA Work 还没有任务数据，请先新建一个任务再导入')
  }
  const existing = await readRuntimeThreadIds(options.executorHome)
  const names = await readSessionNames(options.legacyHome)

  const toCopy: LegacyThread[] = []
  const overwritten: LegacyThread[] = []
  let skipped = 0
  for (const thread of threads) {
    if (!existing.has(thread.id)) {
      toCopy.push(thread)
    } else if (options.mode === 'overwrite') {
      overwritten.push(thread)
      toCopy.push(thread)
    } else {
      skipped += 1
    }
  }

  const copiedIds: string[] = []
  for (const thread of toCopy) {
    const relativePath = relative(join(options.legacyHome, 'sessions'), thread.path).replace(/\\/g, '/')
    const withoutCompression = relativePath.endsWith('.zst')
      ? relativePath.slice(0, -'.zst'.length)
      : relativePath
    await copyRollout(thread.path, join(destinationSessions, withoutCompression))
    copiedIds.push(thread.id)
  }
  log(`copied ${copiedIds.length} codex rollouts`)

  let rows = 0
  if (copiedIds.length > 0) {
    rows = copyHistoryRows(destinationDatabase, legacyDatabase, copiedIds)
    log(`copied ${rows} history rows`)
  }

  for (const thread of toCopy) {
    if (existing.has(thread.id)) continue
    const entry = names.get(thread.id)
    const createdAt =
      parseTimestamp(thread.timestamp) ?? Math.round((await fs.stat(thread.path)).mtimeMs)
    const updatedAt = parseTimestamp(entry?.updatedAt) ?? createdAt
    const title = entry?.name || thread.id
    const task = buildTask(template, thread, title, createdAt, updatedAt)
    tasks[task.local_task_id as string] = task
  }

  runtime.tasks = tasks
  const temporary = `${indexPath}.importing`
  await fs.writeFile(temporary, JSON.stringify(runtime), 'utf8')
  await fs.rename(temporary, indexPath)

  return {
    newConversations: toCopy.length - overwritten.length,
    overwritten: overwritten.length,
    skipped,
    totalCandidates: threads.length,
  }
}

export async function requestCodexImport(options: {
  userDataDirectory: string
  legacyHome: string
  mode: CodexImportMode
}): Promise<void> {
  const request: CodexImportRequest = {
    requestedAt: new Date().toISOString(),
    legacyHome: options.legacyHome,
    mode: options.mode,
  }
  await fs.mkdir(options.userDataDirectory, { recursive: true })
  await fs.writeFile(
    join(options.userDataDirectory, REQUEST_FILE),
    JSON.stringify(request, null, 2),
    'utf8'
  )
}

export async function readCodexImportStatus(
  userDataDirectory: string
): Promise<{ pending: boolean; status: CodexImportStatus | null }> {
  let pending = false
  try {
    await fs.access(join(userDataDirectory, REQUEST_FILE))
    pending = true
  } catch {
    pending = false
  }
  try {
    const status = JSON.parse(
      await fs.readFile(join(userDataDirectory, STATUS_FILE), 'utf8')
    ) as CodexImportStatus
    return { pending, status }
  } catch {
    return { pending, status: null }
  }
}

export async function applyPendingCodexImport(options: {
  executorHome: string
  userDataDirectory: string
  homeDirectory: string
  log?: (message: string) => void
}): Promise<CodexImportStatus | null> {
  const requestPath = join(options.userDataDirectory, REQUEST_FILE)
  let request: CodexImportRequest
  try {
    request = JSON.parse(await fs.readFile(requestPath, 'utf8')) as CodexImportRequest
  } catch {
    return null
  }
  const mode: CodexImportMode = request.mode === 'overwrite' ? 'overwrite' : 'skip'
  const legacyHome = request.legacyHome?.trim() || legacyCodexHome(options.homeDirectory)
  let status: CodexImportStatus
  try {
    const result = await importCodexConversations({
      legacyHome,
      executorHome: options.executorHome,
      mode,
      log: options.log,
    })
    status = { completedAt: new Date().toISOString(), legacyHome, mode, ...result }
  } catch (error) {
    status = {
      completedAt: new Date().toISOString(),
      legacyHome,
      mode,
      newConversations: 0,
      overwritten: 0,
      skipped: 0,
      totalCandidates: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    await fs.writeFile(
      join(options.userDataDirectory, STATUS_FILE),
      JSON.stringify(status, null, 2),
      'utf8'
    )
  } finally {
    await fs.rm(requestPath, { force: true })
  }
  return status
}

export function defaultCodexHomeForImport(): string {
  return join(homedir(), '.codex')
}
