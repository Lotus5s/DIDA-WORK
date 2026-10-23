import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { clearDidaAccount } from '@/api/local/localSession'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  createDefaultLocalModelCatalogEntry,
  DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS,
} from '@/features/model-settings/localModelCatalog'
import { saveProviderConfiguration } from '@/features/model-settings/providerModelConfiguration'
import type {
  ModelConfigurationSnapshot,
  ModelProvider,
  ProviderModel,
  PublicModelProvider,
} from '../../../electron/src/host/model-configuration-contract'

export const DIDA_BASE_URL = 'https://zz.didadida.dpdns.org'
export const DIDA_PROVIDER_ID = 'dida'
export const DIDA_PROVIDER_NAME = 'DIDA'
export const DIDA_FALLBACK_MODEL = 'gpt-6-astra'

export interface DidaUser {
  id?: number | string
  email?: string
  name?: string
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

export const DIDA_OPEN_KEY_SELECTOR_EVENT = 'dida-open-key-selector'
export const DIDA_SIGNED_OUT_EVENT = 'dida-signed-out'

/** Ask the DIDA gate to reopen its key picker after onboarding. */
export function openDidaKeySelector(): void {
  window.dispatchEvent(new Event(DIDA_OPEN_KEY_SELECTOR_EVENT))
}

/**
 * Sign out of DIDA, forget the remembered account and remove the DIDA provider
 * from model.yml so the next launch shows the DIDA login screen.
 */
export async function signOutDida(): Promise<void> {
  await logoutDida()
  clearDidaAccount()
  try {
    const snapshot = await readDidaProviderSnapshot()
    if (snapshot.providers.some(isDidaProvider)) {
      await saveProviderConfiguration(
        snapshot.revision,
        snapshot.providers.filter(provider => !isDidaProvider(provider))
      )
    }
  } catch (error) {
    console.warn('[DIDA] Could not remove the DIDA provider during sign-out', error)
  }
  window.dispatchEvent(new Event(DIDA_SIGNED_OUT_EVENT))
}

/**
 * DIDA groups can expose image, audio, video and helper models next to chat
 * models. The app only lists chat/codex models, so keep one shared filter for
 * onboarding and the live allowlist sync.
 */
const DIDA_NON_CHAT_MARKERS = [
  'image',
  'audio',
  'realtime',
  'video',
  'seedance',
  'embedding',
  'transcribe',
  'whisper',
  'sora',
  'moderation',
  'auto-review',
]

export function isDidaChatModel(model: DidaModel): boolean {
  const id = model.id.toLowerCase()
  return !DIDA_NON_CHAT_MARKERS.some(marker => id.includes(marker))
}

export interface DidaSessionStatus {
  authenticated: boolean
  user?: DidaUser
}

export interface DidaLoginResult extends DidaSessionStatus {
  cancelled?: boolean
}

export function isDidaProvider(
  provider: Pick<ModelProvider | PublicModelProvider, 'name' | 'base_url'>
): boolean {
  return (
    provider.name === DIDA_PROVIDER_NAME ||
    provider.base_url.replace(/\/+$/, '') === DIDA_BASE_URL
  )
}

function sanitizeLocalModelId(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || 'model'
}

export function hasDidaProvider(snapshot: ModelConfigurationSnapshot): boolean {
  return snapshot.providers.some(isDidaProvider)
}

export async function getDidaSession(): Promise<DidaSessionStatus> {
  return invokeDesktopHost<DidaSessionStatus>('dida.session')
}

export async function loginDida(): Promise<DidaLoginResult> {
  return invokeDesktopHost<DidaLoginResult>('dida.login')
}

export async function loginDidaWithPassword(
  email: string,
  password: string
): Promise<DidaLoginResult> {
  return invokeDesktopHost<DidaLoginResult>('dida.login.password', { email, password })
}

export async function logoutDida(): Promise<void> {
  await invokeDesktopHost('dida.logout')
}

export async function listDidaKeys(): Promise<DidaKey[]> {
  const result = await invokeDesktopHost<{ keys: DidaKey[] }>('dida.keys.list')
  return result.keys ?? []
}

export async function listDidaGroups(): Promise<DidaGroup[]> {
  try {
    const result = await invokeDesktopHost<{ groups: DidaGroup[] }>('dida.groups.list')
    return result.groups ?? []
  } catch {
    return []
  }
}

export async function createDidaKey(name: string, groupId?: number | string | null): Promise<DidaKey> {
  const result = await invokeDesktopHost<{ key: DidaKey }>('dida.keys.create', {
    name,
    ...(groupId !== undefined && groupId !== null ? { groupId } : {}),
  })
  return result.key
}

export async function deleteDidaKey(id: number | string): Promise<void> {
  await invokeDesktopHost('dida.keys.delete', { id })
}

export async function listDidaModels(key: string): Promise<DidaModel[]> {
  try {
    const result = await invokeDesktopHost<{ models: DidaModel[] }>('dida.models.list', { key })
    return result.models ?? []
  } catch {
    return []
  }
}

export async function readDidaProviderSnapshot(): Promise<ModelConfigurationSnapshot> {
  return invokeDesktopHost<ModelConfigurationSnapshot>('modelConfiguration.read')
}

function uniqueLocalModelId(base: string, used: Set<string>): string {
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

const DEFAULT_DIDA_CONTEXT_WINDOW = 1_048_576

function didaCatalogEntry(
  localModelId: string,
  displayName: string,
  upstreamModelId: string,
  contextWindow: number
) {
  return {
    ...createDefaultLocalModelCatalogEntry({
      id: localModelId,
      displayName,
      toolProfile: 'custom',
      contextWindow,
    }),
    base_instructions: `${DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS}\n\nThe upstream model serving this session is ${displayName} (model id: ${upstreamModelId}). When asked which model you are, identify yourself as ${displayName}.

The desktop application hosting this session is DIDA Work. Its former names Wework and WeWork are obsolete; never call the application Wework or WeWork. When you refer to the application, call it DIDA Work.`,
  }
}

function createDidaProviderModel(model: DidaModel, localModelId: string): ProviderModel {
  const displayName = model.displayName || model.id
  const contextWindow = model.contextWindow ?? DEFAULT_DIDA_CONTEXT_WINDOW
  return {
    id: localModelId,
    model_id: model.id,
    display_name: displayName,
    provider_profile_id: DIDA_PROVIDER_ID,
    api_format: 'openai-responses',
    request_path: '/responses',
    tool_profile: 'custom',
    codex_tool_compatibility: 'native',
    context_window: contextWindow,
    catalog_entry: didaCatalogEntry(localModelId, displayName, model.id, contextWindow),
    enabled: true,
  }
}

export async function applyDidaProvider(
  key: DidaKey,
  selectedModel: DidaModel,
  availableModels: DidaModel[] = [selectedModel]
): Promise<void> {
  const snapshot = await readDidaProviderSnapshot()
  const providers = snapshot.providers.filter(provider => !isDidaProvider(provider))
  const orderedModels = [
    selectedModel,
    ...availableModels.filter(model => model.id !== selectedModel.id),
  ]
  const usedIds = new Set<string>()
  const modelEntries: ProviderModel[] = orderedModels.map(model => {
    return createDidaProviderModel(
      model,
      uniqueLocalModelId(sanitizeLocalModelId(model.id), usedIds)
    )
  })
  const provider: ModelProvider = {
    id: DIDA_PROVIDER_ID,
    name: DIDA_PROVIDER_NAME,
    base_url: DIDA_BASE_URL,
    api_format: 'openai-responses',
    request_path: '/responses',
    models_path: '/models',
    api_key: key.key,
    enabled: true,
    models: modelEntries,
  }
  await saveProviderConfiguration(snapshot.revision, [provider, ...providers])
}

export interface DidaModelSyncResult {
  updated: boolean
  models: number
  added: string[]
  removed: string[]
}

const DIDA_MODEL_SYNC_MIN_INTERVAL_MS = 5_000
const EMPTY_DIDA_SYNC_RESULT: DidaModelSyncResult = {
  updated: false,
  models: 0,
  added: [],
  removed: [],
}
let didaModelSyncInFlight: Promise<DidaModelSyncResult> | null = null
let didaModelSyncCompletedAt = 0

/**
 * Refresh the saved DIDA provider from the group's current `/models` list.
 *
 * The DIDA group allowlist can change while the app is installed, so the
 * provider must not keep the snapshot captured during onboarding. This reads
 * the saved connection's credential in the main process, keeps the existing
 * local model IDs (so the current selection survives), appends new upstream
 * models and drops models that left the allowlist.
 */
export function syncDidaModels(options: { force?: boolean } = {}): Promise<DidaModelSyncResult> {
  if (!isElectronRuntime()) return Promise.resolve(EMPTY_DIDA_SYNC_RESULT)
  if (didaModelSyncInFlight) return didaModelSyncInFlight
  if (!options.force && Date.now() - didaModelSyncCompletedAt < DIDA_MODEL_SYNC_MIN_INTERVAL_MS) {
    return Promise.resolve(EMPTY_DIDA_SYNC_RESULT)
  }
  didaModelSyncInFlight = runDidaModelSync().finally(() => {
    didaModelSyncCompletedAt = Date.now()
    didaModelSyncInFlight = null
  })
  return didaModelSyncInFlight
}

async function runDidaModelSync(retryOnRevisionConflict = true): Promise<DidaModelSyncResult> {
  const snapshot = await readDidaProviderSnapshot()
  if (snapshot.error) throw new Error(snapshot.error)
  const provider = snapshot.providers.find(isDidaProvider)
  if (!provider) return EMPTY_DIDA_SYNC_RESULT

  const discovered = await discoverDidaProviderModels(provider.id)
  const chatModels = discovered.filter(isDidaChatModel)
  // An empty or failed response must never wipe a working configuration.
  if (chatModels.length === 0) return EMPTY_DIDA_SYNC_RESULT

  const upstreamById = new Map(chatModels.map(model => [model.id, model]))
  const keptEntries: ProviderModel[] = []
  const usedIds = new Set<string>()
  for (const entry of provider.models) {
    const upstream = upstreamById.get(entry.model_id)
    if (!upstream) continue
    usedIds.add(entry.id)
    keptEntries.push(mergeDidaProviderModel(entry, upstream))
  }
  const keptUpstreamIds = new Set(keptEntries.map(entry => entry.model_id))
  const addedModels = chatModels.filter(model => !keptUpstreamIds.has(model.id))
  const entries = [...keptEntries]
  for (const model of addedModels) {
    entries.push(
      createDidaProviderModel(
        model,
        uniqueLocalModelId(sanitizeLocalModelId(model.id), usedIds)
      )
    )
  }
  const removed = provider.models
    .filter(entry => !upstreamById.has(entry.model_id))
    .map(entry => entry.model_id)

  if (
    removed.length === 0 &&
    addedModels.length === 0 &&
    entries.every((entry, index) => sameDidaProviderModel(entry, provider.models[index]))
  ) {
    return { ...EMPTY_DIDA_SYNC_RESULT, models: entries.length }
  }

  const others = snapshot.providers.filter(candidate => !isDidaProvider(candidate))
  const nextProvider: PublicModelProvider = { ...provider, models: entries }
  try {
    await saveProviderConfiguration(snapshot.revision, [nextProvider, ...others])
  } catch (error) {
    if (
      retryOnRevisionConflict &&
      error instanceof Error &&
      error.message.includes('changed externally')
    ) {
      return runDidaModelSync(false)
    }
    throw error
  }
  return {
    updated: true,
    models: entries.length,
    added: addedModels.map(model => model.id),
    removed,
  }
}

async function discoverDidaProviderModels(providerId: string): Promise<DidaModel[]> {
  try {
    const models = await invokeDesktopHost<DidaModel[]>('modelConfiguration.discoverModels', {
      providerId,
    })
    return Array.isArray(models) ? models : []
  } catch {
    return []
  }
}

function mergeDidaProviderModel(entry: ProviderModel, upstream: DidaModel): ProviderModel {
  const displayName = upstream.displayName || entry.display_name || upstream.id
  const contextWindow =
    upstream.contextWindow ?? entry.context_window ?? DEFAULT_DIDA_CONTEXT_WINDOW
  return {
    ...entry,
    display_name: displayName,
    context_window: contextWindow,
    // Rebuild every sync so instruction updates reach already-onboarded installs.
    catalog_entry: didaCatalogEntry(entry.id, displayName, upstream.id, contextWindow),
  }
}

function sameDidaProviderModel(left: ProviderModel, right: ProviderModel | undefined): boolean {
  if (!right) return false
  return (
    left.id === right.id &&
    left.model_id === right.model_id &&
    (left.display_name ?? '') === (right.display_name ?? '') &&
    (left.context_window ?? 0) === (right.context_window ?? 0) &&
    (left.enabled !== false) === (right.enabled !== false) &&
    JSON.stringify(left.catalog_entry ?? null) === JSON.stringify(right.catalog_entry ?? null)
  )
}
