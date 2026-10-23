import { BrowserWindow, session } from 'electron'
import type { BrowserWindow as BrowserWindowType } from 'electron'
import { HostCapabilityError, type HostCapabilityRouter } from './capability-router.js'
import type { SecureValueStore } from './secure-value-store.js'

/**
 * DIDA (Sub2API) onboarding bridge.
 *
 * The renderer never talks to the DIDA origin directly: cookies, Cloudflare
 * Turnstile and the site's JWT live inside a dedicated Electron partition, and
 * all API calls are made from the main process so the renderer stays free of
 * CORS and credential handling.
 */
const DIDA_BASE_URL = (
  process.env.DIDA_BASE_URL?.trim() || 'https://zz.didadida.dpdns.org'
).replace(/\/+$/, '')
const DIDA_LOGIN_PARTITION = 'persist:dida-auth'
const DIDA_SESSION_KEY = 'dida.session.v1'
const SESSION_REFRESH_AHEAD_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const REQUEST_TIMEOUT_MS = 20_000

export interface DidaUser {
  id?: number | string
  email?: string
  name?: string
}

export interface DidaSession {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user: DidaUser
}

export interface DidaKey {
  id: number | string
  name: string
  key: string
  status: string
  quota: number
  quotaUsed: number
  expiresAt: string | null
  groupId: number | string | null
  createdAt: string | null
}

export interface DidaModel {
  id: string
  displayName: string
  contextWindow?: number
}

export interface DidaGroup {
  id: number | string
  name: string
  platform: string
  rateMultiplier: number
  status: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberValue(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseUser(value: unknown): DidaUser {
  const record = asRecord(value)
  if (!record) return {}
  const id = record.id
  return {
    ...(typeof id === 'number' || typeof id === 'string' ? { id } : {}),
    ...(stringValue(record.email) ? { email: stringValue(record.email) } : {}),
    ...(stringValue(record.name) ? { name: stringValue(record.name) } : {}),
  }
}

async function readSession(secrets: SecureValueStore): Promise<DidaSession | null> {
  const raw = await secrets.get(DIDA_SESSION_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<DidaSession> | null
    if (!parsed || typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : '',
      expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0,
      user: parseUser(parsed.user),
    }
  } catch {
    return null
  }
}

async function writeSession(secrets: SecureValueStore, value: DidaSession): Promise<void> {
  await secrets.set(DIDA_SESSION_KEY, JSON.stringify(value))
}

async function requestJson(
  url: string,
  init: RequestInit = {}
): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { response, body }
}

async function refreshSession(
  secrets: SecureValueStore,
  current: DidaSession
): Promise<DidaSession | null> {
  if (current.expiresAt > Date.now() + SESSION_REFRESH_AHEAD_MS) return current
  if (!current.refreshToken) return null
  const { response, body } = await requestJson(`${DIDA_BASE_URL}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: current.refreshToken }),
  })
  const envelope = asRecord(body)
  const data = asRecord(envelope?.data) ?? envelope
  const accessToken = stringValue(data?.access_token)
  if (!response.ok || !accessToken) return null
  const next: DidaSession = {
    accessToken,
    refreshToken: stringValue(data?.refresh_token) || current.refreshToken,
    expiresAt:
      Date.now() + (numberValue(data?.expires_in) || 3600) * 1000,
    user: current.user,
  }
  await writeSession(secrets, next)
  return next
}

async function requireSession(secrets: SecureValueStore): Promise<DidaSession> {
  const stored = await readSession(secrets)
  if (!stored) {
    throw new HostCapabilityError('dida_not_authenticated', '请先登录 DIDA')
  }
  const refreshed = await refreshSession(secrets, stored)
  if (!refreshed) {
    await secrets.delete(DIDA_SESSION_KEY)
    throw new HostCapabilityError('dida_session_expired', 'DIDA 登录已过期，请重新登录')
  }
  return refreshed
}

async function authorizedJson(
  secrets: SecureValueStore,
  path: string,
  init: RequestInit = {}
): Promise<unknown> {
  const token = await requireSession(secrets)
  const { response, body } = await requestJson(`${DIDA_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token.accessToken}`,
    },
  })
  if (response.status === 401) {
    await secrets.delete(DIDA_SESSION_KEY)
    throw new HostCapabilityError('dida_session_expired', 'DIDA 登录已过期，请重新登录')
  }
  if (!response.ok) {
    const envelope = asRecord(body)
    const message = stringValue(envelope?.message) || `DIDA 请求失败（HTTP ${response.status}）`
    throw new HostCapabilityError('dida_request_failed', message, { status: response.status })
  }
  return body
}

function unwrapData(body: unknown): unknown {
  const envelope = asRecord(body)
  return envelope && 'data' in envelope ? envelope.data : body
}

function normalizeKey(value: unknown): DidaKey | null {
  const record = asRecord(value)
  if (!record) return null
  const key = stringValue(record.key)
  if (!key) return null
  const id = record.id
  return {
    id: typeof id === 'number' || typeof id === 'string' ? id : key,
    name: stringValue(record.name) || '未命名 Key',
    key,
    status: stringValue(record.status) || 'active',
    quota: numberValue(record.quota),
    quotaUsed: numberValue(record.quota_used),
    expiresAt: stringValue(record.expires_at) || null,
    groupId:
      typeof record.group_id === 'number' || typeof record.group_id === 'string'
        ? record.group_id
        : null,
    createdAt: stringValue(record.created_at) || null,
  }
}

function normalizeGroup(value: unknown): DidaGroup | null {
  const record = asRecord(value)
  if (!record) return null
  const id = record.id
  if (typeof id !== 'number' && typeof id !== 'string') return null
  return {
    id,
    name: stringValue(record.name) || `Group ${id}`,
    platform: stringValue(record.platform) || 'openai',
    rateMultiplier: numberValue(record.rate_multiplier) || numberValue(record.rateMultiplier),
    status: stringValue(record.status) || 'active',
  }
}

function normalizeModel(value: unknown): DidaModel | null {
  const record = asRecord(value)
  if (!record) return null
  const id =
    stringValue(record.id) ||
    stringValue(record.slug) ||
    stringValue(record.model) ||
    stringValue(record.name)
  if (!id) return null
  const contextWindow =
    numberValue(record.context_window) ||
    numberValue(record.contextWindow) ||
    numberValue(record.max_context_window) ||
    undefined
  return {
    id,
    displayName:
      stringValue(record.display_name) ||
      stringValue(record.displayName) ||
      stringValue(record.name) ||
      id,
    ...(contextWindow ? { contextWindow } : {}),
  }
}

function decodeTokenUser(accessToken: string): DidaUser {
  try {
    const payload = accessToken.split('.')[1]
    if (!payload) return {}
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const decoded = JSON.parse(Buffer.from(normalized, 'base64').toString('utf8')) as {
      email?: unknown
      name?: unknown
      sub?: unknown
      'https://api.openai.com/profile'?: unknown
    }
    const profile = asRecord(decoded['https://api.openai.com/profile'])
    return {
      ...(stringValue(decoded.sub) ? { id: stringValue(decoded.sub) } : {}),
      ...(stringValue(decoded.email) || stringValue(profile?.email)
        ? { email: stringValue(decoded.email) || stringValue(profile?.email) }
        : {}),
      ...(stringValue(decoded.name) || stringValue(profile?.name)
        ? { name: stringValue(decoded.name) || stringValue(profile?.name) }
        : {}),
    }
  } catch {
    return {}
  }
}

async function captureLoginWindow(
  loginWindow: BrowserWindowType,
  secrets: SecureValueStore
): Promise<DidaSession> {
  return new Promise<DidaSession>((resolve, reject) => {
    let settled = false
    let pollTimer: NodeJS.Timeout | null = null
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      if (pollTimer) clearInterval(pollTimer)
      if (!loginWindow.isDestroyed()) loginWindow.close()
      reject(new HostCapabilityError('dida_login_timeout', 'DIDA 登录超时，请重试'))
    }, LOGIN_TIMEOUT_MS)

    const finish = (session: DidaSession) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (pollTimer) clearInterval(pollTimer)
      void writeSession(secrets, session).finally(() => {
        if (!loginWindow.isDestroyed()) loginWindow.close()
        resolve(session)
      })
    }

    const poll = async () => {
      if (settled || loginWindow.isDestroyed()) return
      try {
        const snapshot = (await loginWindow.webContents.executeJavaScript(
          `(() => ({
            accessToken: localStorage.getItem('auth_token'),
            refreshToken: localStorage.getItem('refresh_token'),
            expiresAt: Number(localStorage.getItem('token_expires_at') || 0),
            user: localStorage.getItem('auth_user')
          }))()`,
          true
        )) as {
          accessToken?: unknown
          refreshToken?: unknown
          expiresAt?: unknown
          user?: unknown
        }
        const accessToken = stringValue(snapshot?.accessToken)
        if (!accessToken) return
        let user: DidaUser = {}
        try {
          user = parseUser(JSON.parse(stringValue(snapshot?.user)))
        } catch {
          user = {}
        }
        if (!user.email && !user.name) user = decodeTokenUser(accessToken)
        finish({
          accessToken,
          refreshToken: stringValue(snapshot?.refreshToken),
          expiresAt: numberValue(snapshot?.expiresAt) || Date.now() + 3600_000,
          user,
        })
      } catch {
        // Navigation and first paint make executeJavaScript reject; keep polling.
      }
    }

    loginWindow.on('closed', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (pollTimer) clearInterval(pollTimer)
      reject(new HostCapabilityError('dida_login_cancelled', '已取消 DIDA 登录'))
    })
    loginWindow.webContents.on('did-finish-load', () => {
      void poll()
    })
    void poll()
    pollTimer = setInterval(() => {
      void poll()
    }, 500)
  })
}

export function registerDidaCapabilities(
  router: HostCapabilityRouter,
  window: () => BrowserWindowType | null,
  secrets: SecureValueStore
): void {
  router.register('dida.session', async () => {
    const stored = await readSession(secrets)
    if (!stored) return { authenticated: false }
    const current = await refreshSession(secrets, stored)
    if (!current) {
      await secrets.delete(DIDA_SESSION_KEY)
      return { authenticated: false }
    }
    return { authenticated: true, user: current.user }
  })

  router.register('dida.login', async () => {
    const parent = window()
    const loginWindow = new BrowserWindow({
      width: 520,
      height: 780,
      minWidth: 420,
      minHeight: 620,
      show: false,
      modal: Boolean(parent),
      ...(parent ? { parent } : {}),
      autoHideMenuBar: true,
      title: '登录 DIDA',
      backgroundColor: '#0b1020',
      webPreferences: {
        partition: DIDA_LOGIN_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    loginWindow.once('ready-to-show', () => loginWindow.show())
    loginWindow.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    )
    try {
      await loginWindow.loadURL(`${DIDA_BASE_URL}/login`)
      const result = await captureLoginWindow(loginWindow, secrets)
      return { authenticated: true, user: result.user }
    } catch (error) {
      if (error instanceof HostCapabilityError && error.code === 'dida_login_cancelled') {
        return { authenticated: false, cancelled: true }
      }
      throw error
    } finally {
      if (!loginWindow.isDestroyed()) loginWindow.close()
    }
  })

  router.register('dida.login.password', async params => {
    const email = stringValue(params.email)
    const password = typeof params.password === 'string' ? params.password : ''
    if (!email || !password) {
      throw new HostCapabilityError('dida_credentials_required', '请输入邮箱和密码')
    }
    const { response, body } = await requestJson(`${DIDA_BASE_URL}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const envelope = asRecord(body)
    const data = asRecord(envelope?.data) ?? envelope
    if (!response.ok) {
      const message =
        stringValue(envelope?.message) ||
        stringValue(asRecord(body)?.message) ||
        `登录失败（HTTP ${response.status}）`
      const code = stringValue(envelope?.code) || stringValue(asRecord(body)?.code)
      const reason = stringValue(envelope?.reason) || stringValue(asRecord(body)?.reason)
      const needsBrowser = /turnstile|captcha|2fa|verification|验证/i.test(
        `${message} ${code} ${reason}`
      )
      throw new HostCapabilityError(
        needsBrowser ? 'dida_login_requires_browser' : 'dida_login_failed',
        message,
        { status: response.status, code }
      )
    }
    const accessToken = stringValue(data?.access_token)
    if (!accessToken) {
      const needsBrowser =
        Boolean(stringValue(data?.temp_token)) || data?.requires_2fa === true
      throw new HostCapabilityError(
        needsBrowser ? 'dida_login_requires_browser' : 'dida_login_failed',
        needsBrowser ? '该账号需要二次验证，请改用浏览器登录' : '登录未返回有效的会话'
      )
    }
    const user = parseUser(data?.user)
    const session: DidaSession = {
      accessToken,
      refreshToken: stringValue(data?.refresh_token),
      expiresAt: Date.now() + (numberValue(data?.expires_in) || 3600) * 1000,
      user: user.email || user.name ? user : decodeTokenUser(accessToken),
    }
    await writeSession(secrets, session)
    return { authenticated: true, user: session.user }
  })

  router.register('dida.logout', async () => {
    await secrets.delete(DIDA_SESSION_KEY)
    try {
      await session.fromPartition(DIDA_LOGIN_PARTITION).clearStorageData()
    } catch {
      // The partition may not have been used yet.
    }
    return { ok: true }
  })

  router.register('dida.keys.list', async () => {
    const body = await authorizedJson(secrets, '/api/v1/keys?page=1&page_size=100')
    const data = unwrapData(body)
    const record = asRecord(data)
    const candidates = Array.isArray(data)
      ? data
      : Array.isArray(record?.items)
        ? record.items
        : Array.isArray(record?.list)
          ? record.list
          : Array.isArray(record?.keys)
            ? record.keys
            : []
    const keys = candidates
      .map(normalizeKey)
      .filter((key): key is DidaKey => key !== null)
    return { keys }
  })

  router.register('dida.keys.create', async params => {
    const name = stringValue(params.name) || `Codex-${new Date().toISOString().slice(0, 10)}`
    const payload: Record<string, unknown> = { name }
    if (params.groupId !== undefined && params.groupId !== null) payload.group_id = params.groupId
    if (typeof params.quota === 'number' && params.quota > 0) payload.quota = params.quota
    if (typeof params.expiresInDays === 'number' && params.expiresInDays > 0) {
      payload.expires_in_days = params.expiresInDays
    }
    const body = await authorizedJson(secrets, '/api/v1/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const key = normalizeKey(unwrapData(body))
    if (!key) {
      throw new HostCapabilityError('dida_key_create_empty', '创建成功但未返回 API Key')
    }
    return { key }
  })

  router.register('dida.keys.delete', async params => {
    const id = params.id
    if (typeof id !== 'number' && typeof id !== 'string') {
      throw new HostCapabilityError('dida_key_required', '缺少 API Key ID')
    }
    await authorizedJson(secrets, `/api/v1/keys/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
    })
    return { ok: true }
  })

  router.register('dida.groups.list', async () => {
    const body = await authorizedJson(secrets, '/api/v1/groups/available')
    const data = unwrapData(body)
    const candidates = Array.isArray(data)
      ? data
      : Array.isArray(asRecord(data)?.groups)
        ? (asRecord(data)!.groups as unknown[])
        : []
    const groups = candidates
      .map(normalizeGroup)
      .filter((group): group is DidaGroup => group !== null && group.status === 'active')
    return { groups }
  })

  router.register('dida.models.list', async params => {
    const apiKey = stringValue(params.key)
    if (!apiKey) throw new HostCapabilityError('dida_key_required', '缺少 API Key')
    const { response, body } = await requestJson(`${DIDA_BASE_URL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    if (!response.ok) {
      throw new HostCapabilityError(
        'dida_models_failed',
        `获取模型列表失败（HTTP ${response.status}）`,
        { status: response.status }
      )
    }
    const data = unwrapData(body)
    const record = asRecord(data)
    const candidates = Array.isArray(data)
      ? data
      : Array.isArray(record?.items)
        ? record.items
        : Array.isArray(record?.data)
          ? record.data
          : Array.isArray(record?.models)
            ? record.models
            : Array.isArray(asRecord(body)?.models)
              ? (asRecord(body)!.models as unknown[])
              : []
    const seen = new Set<string>()
    const models: DidaModel[] = []
    for (const candidate of candidates) {
      const model = normalizeModel(candidate)
      if (!model || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
    return { models }
  })
}
