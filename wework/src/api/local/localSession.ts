import type { User, UserPreferences } from '@/types/api'

export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@wework.local',
  preferences: {},
} satisfies User

const LOCAL_USER_PREFERENCES_STORAGE_KEY = 'wework.localUser.preferences'
const DIDA_ACCOUNT_STORAGE_KEY = 'dida.account.v1'

export const DIDA_ACCOUNT_CHANGED_EVENT = 'dida-account-changed'

export interface DidaAccount {
  id?: number | string
  name?: string
  email?: string
}

function readStoredDidaAccount(): DidaAccount {
  try {
    const raw = globalThis.localStorage?.getItem(DIDA_ACCOUNT_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as DidaAccount) : {}
  } catch {
    return {}
  }
}

/** Remember the signed-in DIDA account so the workbench shows it instead of "local". */
export function saveDidaAccount(account: DidaAccount): void {
  const next: DidaAccount = {
    ...(account.id !== undefined ? { id: account.id } : {}),
    ...(account.name?.trim() ? { name: account.name.trim() } : {}),
    ...(account.email?.trim() ? { email: account.email.trim() } : {}),
  }
  try {
    globalThis.localStorage?.setItem(DIDA_ACCOUNT_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // The current session still uses the returned user from getLocalUser.
  }
  try {
    window.dispatchEvent(new Event(DIDA_ACCOUNT_CHANGED_EVENT))
  } catch {
    // Non-browser tests.
  }
}

export function clearDidaAccount(): void {
  try {
    globalThis.localStorage?.removeItem(DIDA_ACCOUNT_STORAGE_KEY)
  } catch {
    // Ignore unavailable storage.
  }
  try {
    window.dispatchEvent(new Event(DIDA_ACCOUNT_CHANGED_EVENT))
  } catch {
    // Non-browser tests.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLocalUserPreferences(): UserPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_USER_PREFERENCES_STORAGE_KEY)
    if (!raw) return LOCAL_USER.preferences

    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as UserPreferences) : LOCAL_USER.preferences
  } catch {
    return LOCAL_USER.preferences
  }
}

export function saveLocalUserPreferences(preferences: UserPreferences): User {
  try {
    globalThis.localStorage?.setItem(
      LOCAL_USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    )
  } catch {
    // Keep the in-session return value even if local persistence is unavailable.
  }

  return {
    ...LOCAL_USER,
    preferences,
  }
}

export function getLocalUser(): User {
  const account = readStoredDidaAccount()
  const userName = account.email?.trim() || account.name?.trim()
  const parsedId = Number(account.id)
  return {
    ...LOCAL_USER,
    ...(Number.isFinite(parsedId) && parsedId > 0 ? { id: parsedId } : {}),
    ...(userName ? { user_name: userName } : {}),
    ...(account.email?.trim() ? { email: account.email.trim() } : {}),
    preferences: readLocalUserPreferences(),
  }
}
