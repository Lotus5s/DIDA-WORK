import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import illustrationUrl from '@/assets/dida-easy-work-office.png'
import { DidaMark } from './DidaMark'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { saveDidaAccount } from '@/api/local/localSession'
import { saveProviderConfiguration } from '@/features/model-settings/providerModelConfiguration'
import {
  applyDidaProvider,
  createDidaKey,
  deleteDidaKey,
  DIDA_FALLBACK_MODEL,
  DIDA_OPEN_KEY_SELECTOR_EVENT,
  DIDA_SIGNED_OUT_EVENT,
  getDidaSession,
  hasDidaProvider,
  isDidaChatModel,
  isDidaProvider,
  listDidaGroups,
  listDidaKeys,
  listDidaModels,
  loginDida,
  loginDidaWithPassword,
  readDidaProviderSnapshot,
  syncDidaModels,
  type DidaGroup,
  type DidaKey,
  type DidaModel,
  type DidaUser,
} from './didaClient'

type Step = 'checking' | 'login' | 'keys' | 'models' | 'applying' | 'done'

const DIDA_SELECTED_KEY_ID_KEY = 'dida.selected-key-id'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '操作失败，请重试'
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : ''
}

function isAuthError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'dida_not_authenticated' || code === 'dida_session_expired'
}

function defaultKeyName(): string {
  return `Codex-${new Date().toISOString().slice(0, 10)}`
}

function keyStatusLabel(status: string): string {
  switch (status) {
    case 'active':
      return '可用'
    case 'inactive':
      return '已停用'
    case 'quota_exhausted':
      return '额度用尽'
    case 'expired':
      return '已过期'
    default:
      return status
  }
}

function keyQuotaLabel(key: DidaKey): string {
  if (!key.quota) return '额度不限'
  return `$${key.quotaUsed.toFixed(2)} / $${key.quota.toFixed(2)}`
}

function keyPrefix(key: string): string {
  if (key.length <= 14) return key
  return `${key.slice(0, 8)}…${key.slice(-4)}`
}

const PREFERRED_DIDA_MODELS = [
  'gpt-6.1-sol',
  'gpt-6-sol',
  'gpt-6-astra',
  'gpt-6',
  'gpt-5.6-sol',
  'gpt-5.6',
]

function preferredModelId(models: DidaModel[]): string {
  for (const id of PREFERRED_DIDA_MODELS) {
    if (models.some(model => model.id === id)) return id
  }
  return models[0]?.id ?? DIDA_FALLBACK_MODEL
}

function groupRateLabel(group: DidaGroup): string {
  return `${group.name} · ${group.rateMultiplier}x`
}

function keyGroupLabel(key: DidaKey, groups: DidaGroup[]): string {
  if (key.groupId === null || key.groupId === undefined) return '未分配分组（不可用）'
  const group = groups.find(candidate => String(candidate.id) === String(key.groupId))
  return group ? groupRateLabel(group) : `分组 ${key.groupId}`
}

/**
 * DIDA keys are only usable when they belong to a group. Prefer the group of
 * an existing key, then the 0.2x Codex group, then any OpenAI group.
 */
function preferredGroupId(groups: DidaGroup[], keys: DidaKey[]): number | string | undefined {
  const existingGroupId = keys.find(
    key =>
      key.groupId !== null &&
      key.groupId !== undefined &&
      groups.some(group => group.id === key.groupId && group.platform === 'openai')
  )?.groupId
  if (
    existingGroupId !== undefined &&
    existingGroupId !== null &&
    groups.some(group => group.id === existingGroupId)
  ) {
    return existingGroupId
  }
  const codexGroup = groups.find(
    group => group.platform === 'openai' && group.name.toLowerCase() === 'codex'
  )
  if (codexGroup) return codexGroup.id
  const openAiGroup = groups.find(group => group.platform === 'openai')
  return openAiGroup?.id ?? groups[0]?.id
}

function readStoredSelectedKeyId(): string | null {
  try {
    return window.localStorage.getItem(DIDA_SELECTED_KEY_ID_KEY)
  } catch {
    return null
  }
}

function storeSelectedKeyId(value: string): void {
  try {
    window.localStorage.setItem(DIDA_SELECTED_KEY_ID_KEY, value)
  } catch {
    // The badge is optional.
  }
}

export function DidaGate({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<Step>('checking')
  const [user, setUser] = useState<DidaUser | null>(null)
  const [keys, setKeys] = useState<DidaKey[]>([])
  const [groups, setGroups] = useState<DidaGroup[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<number | string | undefined>()
  const [models, setModels] = useState<DidaModel[]>([])
  const [selectedKey, setSelectedKey] = useState<DidaKey | null>(null)
  const [selectedModelId, setSelectedModelId] = useState('')
  const [newKeyName, setNewKeyName] = useState(defaultKeyName)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [keySearch, setKeySearch] = useState('')
  const [keyToDelete, setKeyToDelete] = useState<DidaKey | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [currentKeyId, setCurrentKeyId] = useState<string | null>(readStoredSelectedKeyId)
  const [hasExistingProvider, setHasExistingProvider] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [useBrowserLogin, setUseBrowserLogin] = useState(false)

  const loadKeySelection = useCallback(async () => {
    const [keyList, groupList] = await Promise.all([listDidaKeys(), listDidaGroups()])
    setKeys(keyList)
    setGroups(groupList)
    setSelectedGroupId(preferredGroupId(groupList, keyList))
  }, [])

  useEffect(() => {
    let cancelled = false
    async function bootstrap() {
      try {
        const session = await getDidaSession()
        if (cancelled) return
        if (!session.authenticated) {
          setStep('login')
          return
        }
        setUser(session.user ?? null)
        if (session.user) saveDidaAccount(session.user)
        const snapshot = await readDidaProviderSnapshot()
        if (cancelled) return
        if (hasDidaProvider(snapshot)) {
          setHasExistingProvider(true)
          setStep('done')
          return
        }
        const [keyList, groupList] = await Promise.all([listDidaKeys(), listDidaGroups()])
        if (cancelled) return
        setKeys(keyList)
        setGroups(groupList)
        setSelectedGroupId(preferredGroupId(groupList, keyList))
        setStep('keys')
      } catch (bootstrapError) {
        if (cancelled) return
        if (isAuthError(bootstrapError)) {
          setStep('login')
          return
        }
        setError(errorMessage(bootstrapError))
        setStep('login')
      }
    }
    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [])

  // The account menu reopens this picker so an installed app can switch keys.
  useEffect(() => {
    const openKeySelector = () => {
      setError(null)
      setKeySearch('')
      setBusy(true)
      void loadKeySelection()
        .then(() => setStep('keys'))
        .catch(selectionError => {
          if (isAuthError(selectionError)) {
            setStep('login')
            return
          }
          setError(errorMessage(selectionError))
        })
        .finally(() => setBusy(false))
    }
    window.addEventListener(DIDA_OPEN_KEY_SELECTOR_EVENT, openKeySelector)
    return () => window.removeEventListener(DIDA_OPEN_KEY_SELECTOR_EVENT, openKeySelector)
  }, [loadKeySelection])

  useEffect(() => {
    const handleSignedOut = () => {
      setUser(null)
      setKeys([])
      setGroups([])
      setSelectedGroupId(undefined)
      setSelectedKey(null)
      setModels([])
      setHasExistingProvider(false)
      setError(null)
      setStep('login')
    }
    window.addEventListener(DIDA_SIGNED_OUT_EVENT, handleSignedOut)
    return () => window.removeEventListener(DIDA_SIGNED_OUT_EVENT, handleSignedOut)
  }, [])

  // Keep the installed model catalog aligned with the DIDA group allowlist.
  // Onboarding captures a snapshot; upstream groups can change later, so sync
  // on startup and whenever the window regains focus (shared 5s throttle).
  useEffect(() => {
    if (step !== 'done') return
    const sync = () => {
      void syncDidaModels().catch(syncError => {
        console.warn('[DIDA] Model allowlist sync failed', syncError)
      })
    }
    sync()
    window.addEventListener('focus', sync)
    return () => window.removeEventListener('focus', sync)
  }, [step])

  const finishLogin = useCallback(
    async (result: { authenticated: boolean; cancelled?: boolean; user?: DidaUser }) => {
      if (!result.authenticated) {
        if (!result.cancelled) setError('登录未完成，请重试')
        return
      }
      setUser(result.user ?? null)
      if (result.user) saveDidaAccount(result.user)
      await loadKeySelection()
      setPassword('')
      setUseBrowserLogin(false)
      setStep('keys')
    },
    [loadKeySelection]
  )

  const handleBrowserLogin = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await finishLogin(await loginDida())
    } catch (loginError) {
      setError(errorMessage(loginError))
    } finally {
      setBusy(false)
    }
  }, [finishLogin])

  const handlePasswordLogin = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!email.trim() || !password) {
        setError('请输入邮箱和密码')
        return
      }
      setBusy(true)
      setError(null)
      try {
        await finishLogin(await loginDidaWithPassword(email.trim(), password))
      } catch (loginError) {
        if (errorCode(loginError) === 'dida_login_requires_browser') {
          setUseBrowserLogin(true)
          setError('该账号需要验证码或二次验证，请使用 DIDA 官网登录页。')
        } else {
          setError(errorMessage(loginError))
        }
      } finally {
        setBusy(false)
      }
    },
    [email, finishLogin, password]
  )

  const handleUseKey = useCallback(async (key: DidaKey) => {
    if (key.groupId === null || key.groupId === undefined) {
      setError('这个 Key 没有分配分组，无法使用。请新建一个已分组的 Key。')
      return
    }
    setSelectedKey(key)
    setBusy(true)
    setError(null)
    try {
      const discovered = await listDidaModels(key.key)
      const chatModels = discovered.filter(isDidaChatModel)
      const available =
        chatModels.length > 0
          ? chatModels
          : discovered.length > 0
            ? discovered
            : [{ id: DIDA_FALLBACK_MODEL, displayName: DIDA_FALLBACK_MODEL }]
      setModels(available)
      setSelectedModelId(preferredModelId(available))
      setStep('models')
    } catch (modelError) {
      setError(errorMessage(modelError))
    } finally {
      setBusy(false)
    }
  }, [])

  const handleCreateKey = useCallback(async () => {
    if (selectedGroupId === undefined) {
      setError('请选择 API Key 所属分组，否则 Key 无法使用。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await createDidaKey(
        newKeyName.trim() || defaultKeyName(),
        selectedGroupId
      )
      setKeys(current => [created, ...current.filter(key => key.id !== created.id)])
      await handleUseKey(created)
    } catch (createError) {
      setError(errorMessage(createError))
    } finally {
      setBusy(false)
    }
  }, [handleUseKey, newKeyName, selectedGroupId])

  const handleDeleteKey = useCallback(async () => {
    const key = keyToDelete
    if (!key) return
    setBusy(true)
    setDeleteError(null)
    try {
      await deleteDidaKey(key.id)
      setKeys(current => current.filter(item => String(item.id) !== String(key.id)))
      if (selectedKey && String(selectedKey.id) === String(key.id)) {
        setSelectedKey(null)
        setModels([])
      }
      if (currentKeyId === String(key.id)) {
        const snapshot = await readDidaProviderSnapshot()
        if (snapshot.providers.some(isDidaProvider)) {
          await saveProviderConfiguration(
            snapshot.revision,
            snapshot.providers.filter(provider => !isDidaProvider(provider))
          )
        }
        setCurrentKeyId(null)
        setHasExistingProvider(false)
        try {
          window.localStorage.removeItem(DIDA_SELECTED_KEY_ID_KEY)
        } catch {
          // The stale badge is harmless.
        }
      }
      setKeyToDelete(null)
      setStep('keys')
    } catch (deleteFailure) {
      setDeleteError(errorMessage(deleteFailure))
    } finally {
      setBusy(false)
    }
  }, [currentKeyId, keyToDelete, selectedKey])

  const handleStart = useCallback(async () => {
    if (!selectedKey) return
    const model =
      models.find(candidate => candidate.id === selectedModelId) ??
      ({ id: selectedModelId || DIDA_FALLBACK_MODEL, displayName: selectedModelId } as DidaModel)
    setBusy(true)
    setStep('applying')
    setError(null)
    try {
      await applyDidaProvider(selectedKey, model, models.length > 0 ? models : [model])
      storeSelectedKeyId(String(selectedKey.id))
      setCurrentKeyId(String(selectedKey.id))
      setHasExistingProvider(true)
      setStep('done')
    } catch (applyError) {
      setError(errorMessage(applyError))
      setStep('models')
    } finally {
      setBusy(false)
    }
  }, [models, selectedKey, selectedModelId])

  const accountLabel = useMemo(() => {
    if (!user) return null
    return user.email || user.name || 'DIDA 账号'
  }, [user])

  const openAiGroups = useMemo(
    () => groups.filter(group => group.platform === 'openai'),
    [groups]
  )

  const visibleKeys = useMemo(() => {
    const query = keySearch.trim().toLowerCase()
    if (!query) return keys
    return keys.filter(key =>
      [key.name, key.key, keyGroupLabel(key, groups)].join(' ').toLowerCase().includes(query)
    )
  }, [groups, keySearch, keys])

  const closeGate = useCallback(() => {
    setError(null)
    setStep('done')
  }, [])

  if (step === 'done') return <>{children}</>

  const brandPanel = (
    <aside className="relative hidden w-[44%] max-w-[760px] shrink-0 overflow-hidden border-r border-[#e3e8dc] bg-[#eef2e7] lg:flex">
      <div className="flex h-full w-full flex-col justify-between px-10 py-8">
        <div className="flex items-center gap-3">
          <DidaMark className="h-10 w-10 shrink-0" />
          <div>
            <div className="text-xl font-semibold tracking-tight text-[#1f2a1d]">
              DIDA <span className="font-normal">easy work</span>
            </div>
            <div className="text-xs text-[#5f6b5a]">AI 工作台</div>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center py-6">
          <img
            src={illustrationUrl}
            alt="戴眼镜的办公人在桌前使用电脑，轻松端着一杯咖啡"
            className="max-h-[54vh] w-auto max-w-full object-contain"
          />
        </div>

        <div className="flex justify-center">
          <div className="rounded-lg bg-[#3f5a3c] px-4 py-2 text-sm font-medium text-white shadow-sm">
            工作前，先放松一下~
          </div>
        </div>
      </div>
    </aside>
  )

  const topActions = (
    <div className="absolute right-6 top-6 z-20 flex items-center gap-2">
      {hasExistingProvider && (
        <button
          type="button"
          className="rounded-lg border border-[#dfe5d8] bg-white/80 px-3 py-1.5 text-sm font-medium text-[#5f6b5a] backdrop-blur hover:border-[#b9c4b0] hover:text-[#1f2a1d]"
          onClick={closeGate}
        >
          取消
        </button>
      )}
      <button
        type="button"
        className="rounded-lg border border-[#dfe5d8] bg-white/80 px-3 py-1.5 text-sm font-medium text-[#5f6b5a] backdrop-blur hover:border-[#b9c4b0] hover:text-[#1f2a1d]"
        onClick={() => void invokeDesktopHost('app.quit')}
        aria-label="退出 DIDA Work"
      >
        退出
      </button>
    </div>
  )

  const errorBanner = error ? (
    <div className="mt-5 flex items-start gap-2 rounded-xl border border-[#f0d2cc] bg-[#fdf3f1] px-4 py-3 text-sm leading-6 text-[#9b3d32]">
      <X className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{error}</span>
    </div>
  ) : null

  return (
    <>
      {children}
      <div className="fixed inset-0 z-[2147483600] overflow-hidden bg-[#fbfcf8] text-[#1f2a1d]">
        <div className="flex h-full">
          {brandPanel}

          <main className="relative flex min-w-0 flex-1 flex-col overflow-y-auto bg-white">
            <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-[#f6f8f2] to-transparent" />
            {topActions}

            <div
              className={`mx-auto flex min-h-full w-full flex-1 flex-col justify-center px-6 py-20 sm:px-10 ${
                step === 'keys' ? 'max-w-5xl' : 'max-w-[560px]'
              }`}
            >
              {step === 'checking' && (
                <div className="flex flex-col items-center gap-3 text-center text-sm text-[#6b7566]">
                  <Loader2 className="h-6 w-6 animate-spin text-[#3f5a3c]" />
                  正在检查 DIDA 登录状态…
                </div>
              )}

              {step === 'login' && (
                <div className="w-full">
                  <div className="mb-8 flex items-center gap-3 lg:hidden">
                    <DidaMark className="h-10 w-10 shrink-0" />
                    <div className="text-lg font-semibold">DIDA easy work</div>
                  </div>
                  <h1 className="text-[30px] font-semibold tracking-tight text-[#1f2a1d]">
                    欢迎回来
                  </h1>
                  <p className="mt-2 text-sm leading-6 text-[#6b7566]">
                    登录你的 DIDA 账号，选择 API Key 后即可开始使用 DIDA Work。
                  </p>

                  {!useBrowserLogin ? (
                    <form className="mt-8 space-y-5" onSubmit={event => void handlePasswordLogin(event)}>
                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-[#3d4739]">邮箱</span>
                        <span className="relative block">
                          <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9aa391]" />
                          <input
                            type="email"
                            autoComplete="username"
                            className="h-12 w-full rounded-xl border border-[#dfe5d8] bg-white pl-10 pr-3 text-sm text-[#1f2a1d] outline-none transition focus:border-[#3f5a3c] focus:ring-2 focus:ring-[#3f5a3c]/10"
                            value={email}
                            disabled={busy}
                            onChange={event => setEmail(event.target.value)}
                            placeholder="请输入邮箱"
                          />
                        </span>
                      </label>

                      <label className="block space-y-2">
                        <span className="text-sm font-medium text-[#3d4739]">密码</span>
                        <span className="relative block">
                          <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9aa391]" />
                          <input
                            type={showPassword ? 'text' : 'password'}
                            autoComplete="current-password"
                            className="h-12 w-full rounded-xl border border-[#dfe5d8] bg-white pl-10 pr-11 text-sm text-[#1f2a1d] outline-none transition focus:border-[#3f5a3c] focus:ring-2 focus:ring-[#3f5a3c]/10"
                            value={password}
                            disabled={busy}
                            onChange={event => setPassword(event.target.value)}
                            placeholder="请输入密码"
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-[#9aa391] hover:bg-[#f2f5ee] hover:text-[#3d4739]"
                            onClick={() => setShowPassword(value => !value)}
                            aria-label={showPassword ? '隐藏密码' : '显示密码'}
                          >
                            {showPassword ? (
                              <EyeOff className="h-4 w-4" />
                            ) : (
                              <Eye className="h-4 w-4" />
                            )}
                          </button>
                        </span>
                      </label>

                      {errorBanner}

                      <button
                        type="submit"
                        disabled={busy}
                        className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#111311] text-sm font-semibold text-white transition hover:bg-[#232723] disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <KeyRound className="h-4 w-4" />
                        )}
                        {busy ? '正在登录…' : '登录'}
                      </button>
                    </form>
                  ) : (
                    <div className="mt-8 rounded-2xl border border-[#e3e8dc] bg-[#f8faf6] p-5">
                      <div className="text-sm font-medium text-[#1f2a1d]">
                        需要通过 DIDA 官网登录页验证
                      </div>
                      <p className="mt-1 text-sm leading-6 text-[#6b7566]">
                        验证码、二次验证或通行密钥需要浏览器窗口完成。登录成功后会自动返回这里。
                      </p>
                      {errorBanner}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void handleBrowserLogin()}
                        className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#111311] text-sm font-semibold text-white disabled:opacity-60"
                      >
                        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                        {busy ? '正在打开登录页…' : '打开 DIDA 登录页'}
                      </button>
                    </div>
                  )}

                  <div className="mt-6 text-center text-sm text-[#6b7566]">
                    {!useBrowserLogin ? (
                      <>
                        无法使用密码登录？
                        <button
                          type="button"
                          className="ml-1 font-medium text-[#2f6b45] hover:underline"
                          onClick={() => setUseBrowserLogin(true)}
                        >
                          使用 DIDA 官网登录页
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="font-medium text-[#2f6b45] hover:underline"
                        onClick={() => setUseBrowserLogin(false)}
                      >
                        返回密码登录
                      </button>
                    )}
                  </div>

                  <p className="mt-10 text-xs leading-5 text-[#8a9385]">
                    登录凭据仅保存在本机，使用系统级加密存储，不会上传到 Codex 或第三方。
                  </p>
                </div>
              )}

              {step === 'keys' && (
                <div className="w-full max-w-5xl">
                  <div className="flex flex-wrap items-end justify-between gap-4">
                    <div>
                      <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8a9385]">
                        DIDA Work
                      </div>
                      <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-[#1f2a1d]">
                        选择 API Key
                      </h1>
                      <p className="mt-2 text-sm text-[#6b7566]">
                        {accountLabel ? `当前账号 ${accountLabel}` : '登录 DIDA 账号'}
                        <span className="mx-2 text-[#c3cabf]">·</span>
                        选择一个 Key，或创建一个新的
                      </p>
                    </div>
                    <div className="rounded-full border border-[#e3e8dc] bg-[#f8faf6] px-3 py-1 text-xs font-medium text-[#5f6b5a]">
                      {keys.length} 个 Key
                    </div>
                  </div>

                  <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                    <section className="min-w-0">
                      <div className="relative">
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9aa391]" />
                        <input
                          className="h-11 w-full rounded-xl border border-[#dfe5d8] bg-white pl-10 pr-3 text-sm outline-none transition focus:border-[#3f5a3c] focus:ring-2 focus:ring-[#3f5a3c]/10"
                          value={keySearch}
                          onChange={event => setKeySearch(event.target.value)}
                          placeholder="搜索 Key 名称、前缀或分组"
                        />
                      </div>
                      <div className="mt-2 text-[11px] text-[#9aa391]">
                        点击 Key 继续；右侧垃圾桶可删除 Key。
                      </div>

                      {visibleKeys.length > 0 ? (
                        <div className="mt-3 max-h-[52vh] space-y-2.5 overflow-y-auto pr-1">
                          {visibleKeys.map(key => {
                            const isCurrent = currentKeyId === String(key.id)
                            const unusable = key.groupId === null || key.groupId === undefined
                            return (
                              <div
                                key={String(key.id)}
                                className={`group flex w-full items-start rounded-xl border bg-white transition ${
                                  unusable
                                    ? 'border-[#f0d2cc] opacity-70'
                                    : isCurrent
                                      ? 'border-[#3f5a3c] ring-1 ring-[#3f5a3c]/15'
                                      : 'border-[#e3e8dc] hover:border-[#9aa790]'
                                }`}
                              >
                                <button
                                  type="button"
                                  disabled={busy || unusable}
                                  className={`flex min-w-0 flex-1 items-start justify-between gap-4 rounded-xl p-4 text-left transition ${
                                    unusable ? 'cursor-not-allowed' : 'hover:bg-[#fbfcf8]'
                                  }`}
                                  onClick={() => void handleUseKey(key)}
                                >
                                  <span className="min-w-0">
                                    <span className="flex items-center gap-2">
                                      <span className="truncate text-sm font-semibold text-[#1f2a1d]">
                                        {key.name}
                                      </span>
                                      {isCurrent && (
                                        <span className="shrink-0 rounded-full bg-[#e8f0e4] px-2 py-0.5 text-[10px] font-semibold text-[#3f5a3c]">
                                          当前使用
                                        </span>
                                      )}
                                    </span>
                                    <span className="mt-1 block font-mono text-xs text-[#7b8576]">
                                      {keyPrefix(key.key)}
                                    </span>
                                    <span
                                      className={`mt-2 inline-flex rounded-full px-2 py-0.5 text-[11px] ${
                                        unusable
                                          ? 'bg-[#fdf3f1] text-[#9b3d32]'
                                          : 'bg-[#f2f5ee] text-[#4f5f49]'
                                      }`}
                                    >
                                      {keyGroupLabel(key, groups)}
                                    </span>
                                  </span>
                                  <span className="shrink-0 text-right text-xs">
                                    <span
                                      className={`block font-medium ${
                                        key.status === 'active'
                                          ? 'text-[#2f6b45]'
                                          : 'text-[#a8731f]'
                                      }`}
                                    >
                                      {keyStatusLabel(key.status)}
                                    </span>
                                    <span className="mt-1 block text-[#7b8576]">
                                      {keyQuotaLabel(key)}
                                    </span>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  className="mr-2 mt-3 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[#b0b8a8] opacity-70 transition hover:bg-[#fdf3f1] hover:text-[#9b3d32] hover:opacity-100 disabled:opacity-40"
                                  onClick={() => {
                                    setDeleteError(null)
                                    setKeyToDelete(key)
                                  }}
                                  aria-label={`删除 API Key ${key.name}`}
                                  title="删除"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="mt-3 rounded-xl border border-dashed border-[#dfe5d8] bg-[#fbfcf8] px-4 py-12 text-center text-sm text-[#7b8576]">
                          {keys.length > 0 ? '没有匹配的 Key' : '还没有 API Key，创建一个即可开始'}
                        </div>
                      )}

                      {keys.some(key => key.groupId === null || key.groupId === undefined) && (
                        <div className="mt-3 rounded-xl border border-[#f0d2cc] bg-[#fdf3f1] px-4 py-3 text-xs leading-5 text-[#9b3d32]">
                          有 Key 没有分配分组，调用时会返回 403（API Key is not assigned to any
                          group）。请用右侧面板新建一个已分组的 Key。
                        </div>
                      )}
                    </section>

                    <aside className="self-start rounded-2xl border border-[#e3e8dc] bg-[#f8faf6] p-5">
                      <div className="flex items-center gap-2 text-sm font-semibold text-[#1f2a1d]">
                        <KeyRound className="h-4 w-4 text-[#3f5a3c]" />
                        创建新 Key
                      </div>
                      <p className="mt-1 text-xs leading-5 text-[#7b8576]">
                        Key 必须属于一个分组；Codex 分组为 0.2x。
                      </p>

                      <label className="mt-4 block space-y-1.5">
                        <span className="text-xs font-medium text-[#5f6b5a]">分组（必须选择）</span>
                        <select
                          className="h-11 w-full rounded-xl border border-[#dfe5d8] bg-white px-3 text-sm outline-none transition focus:border-[#3f5a3c] focus:ring-2 focus:ring-[#3f5a3c]/10"
                          value={selectedGroupId === undefined ? '' : String(selectedGroupId)}
                          disabled={busy || openAiGroups.length === 0}
                          onChange={event => {
                            const group = openAiGroups.find(
                              candidate => String(candidate.id) === event.target.value
                            )
                            setSelectedGroupId(group?.id)
                          }}
                        >
                          {openAiGroups.length === 0 && <option value="">未获取到分组</option>}
                          {openAiGroups.map(group => (
                            <option key={String(group.id)} value={String(group.id)}>
                              {groupRateLabel(group)}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="mt-3 block space-y-1.5">
                        <span className="text-xs font-medium text-[#5f6b5a]">Key 名称</span>
                        <input
                          className="h-11 w-full rounded-xl border border-[#dfe5d8] bg-white px-3 text-sm outline-none transition focus:border-[#3f5a3c] focus:ring-2 focus:ring-[#3f5a3c]/10"
                          value={newKeyName}
                          disabled={busy}
                          onChange={event => setNewKeyName(event.target.value)}
                          placeholder="例如 Codex-PC"
                        />
                      </label>

                      <button
                        type="button"
                        className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-[#111311] text-sm font-semibold text-white transition hover:bg-[#232723] disabled:cursor-not-allowed disabled:opacity-60"
                        disabled={busy || selectedGroupId === undefined}
                        onClick={() => void handleCreateKey()}
                      >
                        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        {busy ? '处理中…' : '创建并使用'}
                      </button>

                      {errorBanner}
                    </aside>
                  </div>
                </div>
              )}

              {step === 'models' && selectedKey && (
                <div className="w-full max-w-3xl">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 text-sm font-medium text-[#5f6b5a] hover:text-[#1f2a1d]"
                    onClick={() => {
                      setError(null)
                      setStep('keys')
                    }}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    返回 Key 列表
                  </button>

                  <div className="mt-6">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#8a9385]">
                      DIDA Work
                    </div>
                    <h1 className="mt-2 text-[28px] font-semibold tracking-tight text-[#1f2a1d]">
                      选择模型
                    </h1>
                    <p className="mt-2 text-sm text-[#6b7566]">
                      当前 Key：{selectedKey.name}
                      <span className="mx-2 text-[#c3cabf]">·</span>
                      <span className="font-mono">{keyPrefix(selectedKey.key)}</span>
                    </p>
                  </div>

                  <div className="mt-7 grid gap-3 sm:grid-cols-2">
                    {models.map(model => {
                      const active = selectedModelId === model.id
                      return (
                        <button
                          key={model.id}
                          type="button"
                          className={`flex items-start justify-between gap-3 rounded-xl border bg-white p-4 text-left transition ${
                            active
                              ? 'border-[#3f5a3c] ring-1 ring-[#3f5a3c]/15'
                              : 'border-[#e3e8dc] hover:border-[#9aa790] hover:bg-[#fbfcf8]'
                          }`}
                          onClick={() => setSelectedModelId(model.id)}
                        >
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-[#1f2a1d]">
                              {model.displayName || model.id}
                            </span>
                            <span className="mt-1 block font-mono text-xs text-[#7b8576]">
                              {model.id}
                            </span>
                          </span>
                          {active && (
                            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#3f5a3c] text-white">
                              <Check className="h-3 w-3" />
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>

                  {errorBanner}

                  <button
                    type="button"
                    className="mt-7 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#111311] text-sm font-semibold text-white transition hover:bg-[#232723] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={busy || !selectedModelId}
                    onClick={() => void handleStart()}
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {busy ? '正在配置…' : '开始使用 DIDA Work'}
                    {!busy && <ArrowRight className="h-4 w-4" />}
                  </button>
                </div>
              )}

              {step === 'applying' && (
                <div className="flex flex-col items-center gap-3 text-center text-sm text-[#6b7566]">
                  <Loader2 className="h-6 w-6 animate-spin text-[#3f5a3c]" />
                  正在写入 DIDA 供应商配置…
                </div>
              )}
            </div>
          </main>
        </div>

        {keyToDelete && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#111111]/30 p-6 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-2xl border border-[#e3e8dc] bg-white p-6 shadow-2xl">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#fdf3f1] text-[#9b3d32]">
                  <Trash2 className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold text-[#1f2a1d]">删除这个 API Key？</div>
                  <p className="mt-1 text-sm leading-6 text-[#6b7566]">
                    <span className="font-medium text-[#1f2a1d]">{keyToDelete.name}</span>
                    <span className="mx-1 font-mono text-xs">({keyPrefix(keyToDelete.key)})</span>
                    删除后无法恢复。
                    {currentKeyId === String(keyToDelete.id)
                      ? ' 它正在被当前配置使用，删除后 DIDA Work 会同时移除当前供应商配置。'
                      : ' 正在使用它的其他客户端会立即失效。'}
                  </p>
                </div>
              </div>

              {deleteError && (
                <div className="mt-4 rounded-lg border border-[#f0d2cc] bg-[#fdf3f1] px-3 py-2 text-xs leading-5 text-[#9b3d32]">
                  {deleteError}
                </div>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  className="h-10 rounded-xl border border-[#dfe5d8] px-4 text-sm font-medium text-[#5f6b5a] hover:border-[#b9c4b0] hover:text-[#1f2a1d]"
                  disabled={busy}
                  onClick={() => {
                    setKeyToDelete(null)
                    setDeleteError(null)
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="flex h-10 items-center justify-center gap-2 rounded-xl bg-[#b44336] px-4 text-sm font-semibold text-white transition hover:bg-[#9b3d32] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={busy}
                  onClick={() => void handleDeleteKey()}
                >
                  {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {busy ? '正在删除…' : '删除'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
