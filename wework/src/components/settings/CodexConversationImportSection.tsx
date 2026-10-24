import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2 } from 'lucide-react'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { SettingsGroup, SettingsRow } from './settings-ui'

interface CodexImportStatus {
  completedAt: string
  legacyHome: string
  mode: 'skip' | 'overwrite'
  newConversations: number
  overwritten: number
  skipped: number
  totalCandidates: number
  error?: string
}

interface CodexImportStatusResult {
  pending: boolean
  status: CodexImportStatus | null
}

interface CodexImportScan {
  available: boolean
  legacyHome: string
  total: number
  newCount: number
  duplicateCount: number
  error?: string
}

type DialogStep = { kind: 'confirm'; scan: CodexImportScan } | null

export function CodexConversationImportSection() {
  const { t } = useTranslation('common')
  const [status, setStatus] = useState<CodexImportStatusResult | null>(null)
  const [scan, setScan] = useState<CodexImportScan | null>(null)
  const [dialog, setDialog] = useState<DialogStep>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const result = await invokeDesktopHost<CodexImportStatusResult>('dida.codexImport.status')
      setStatus(result)
    } catch (error) {
      console.debug('[codex-import] status unavailable', error)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const startScan = useCallback(async () => {
    setBusy(true)
    setMessage(null)
    try {
      const result = await invokeDesktopHost<CodexImportScan>('dida.codexImport.scan')
      setScan(result)
      if (result.error) {
        setMessage(result.error)
      } else if (!result.available) {
        setMessage(
          t(
            'workbench.codex_import_not_found',
            '没有找到可导入的 Codex 对话（未检测到本机 Codex 会话目录）。'
          )
        )
      } else if (result.newCount === 0 && result.duplicateCount === 0) {
        setMessage(t('workbench.codex_import_empty', 'Codex 中没有可导入的用户对话。'))
      } else {
        setDialog({ kind: 'confirm', scan: result })
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [t])

  const startImport = useCallback(
    async (mode: 'skip' | 'overwrite') => {
      setBusy(true)
      try {
        await invokeDesktopHost('dida.codexImport.request', { mode })
        await invokeDesktopHost('app.relaunch')
      } catch (error) {
        setBusy(false)
        setDialog(null)
        setMessage(error instanceof Error ? error.message : String(error))
      }
    },
    []
  )

  const duplicateCount = scan?.duplicateCount ?? 0
  const statusLine = status?.pending
    ? t(
        'workbench.codex_import_pending',
        '导入已排入队列，正在重启应用；导入会在下次启动时完成。'
      )
    : status?.status
      ? status.status.error
        ? t('workbench.codex_import_failed', '上次导入失败：{{error}}', {
            error: status.status.error,
          })
        : t(
            'workbench.codex_import_last',
            '上次导入：新增 {{added}} 条，覆盖 {{overwritten}} 条，跳过 {{skipped}} 条（{{time}}）',
            {
              added: status.status.newConversations,
              overwritten: status.status.overwritten,
              skipped: status.status.skipped,
              time: new Date(status.status.completedAt).toLocaleString(),
            }
          )
      : null

  return (
    <>
      <section className="mt-6">
        <SettingsGroup className="rounded-xl !bg-background">
          <SettingsRow
            label={t('workbench.codex_import_title', '从 Codex 导入对话')}
            description={t(
              'workbench.codex_import_description',
              '把本机 Codex 中已有的用户对话复制到 DIDA Work。原 Codex 数据只读不修改；已完成导入的对话可以跳过或覆盖。导入会在应用重启后执行。'
            )}
            control={
              <button
                type="button"
                data-testid="codex-import-button"
                disabled={busy}
                onClick={() => void startScan()}
                className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('workbench.codex_import_action', '导入')}
              </button>
            }
          />
          {(statusLine || message) && (
            <div
              data-testid="codex-import-status"
              className="px-4 pb-3 text-xs leading-5 text-text-secondary"
            >
              {message ?? statusLine}
            </div>
          )}
        </SettingsGroup>
      </section>
      {dialog ? (
        <CodexImportDialog
          scan={dialog.scan}
          duplicateCount={duplicateCount}
          busy={busy}
          onCancel={() => setDialog(null)}
          onStart={mode => void startImport(mode)}
        />
      ) : null}
    </>
  )
}

function CodexImportDialog({
  scan,
  duplicateCount,
  busy,
  onCancel,
  onStart,
}: {
  scan: CodexImportScan
  duplicateCount: number
  busy: boolean
  onCancel: () => void
  onStart: (mode: 'skip' | 'overwrite') => void
}) {
  const dialogRef = useDialogKeyboard<HTMLDivElement>(() => {
    if (!busy) onCancel()
  }, true)
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="codex-import-dialog-title"
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-[460px] flex-col rounded-[20px] border border-border bg-popover p-5 text-text-primary shadow-lg"
      >
        <h2 id="codex-import-dialog-title" className="text-lg font-medium">
          导入 Codex 对话
        </h2>
        <div className="mt-2 min-h-0 overflow-y-auto text-sm leading-5 text-text-secondary">
          <p>
            共发现 <span className="text-text-primary">{scan.total}</span> 条用户对话，其中{' '}
            <span className="text-text-primary">{scan.newCount}</span> 条尚未导入
            {duplicateCount > 0 ? (
              <>
                ，<span className="text-text-primary">{duplicateCount}</span> 条已存在
              </>
            ) : null}
            。
          </p>
          <p className="mt-2">
            导入会在应用重启后完成。原 Codex 目录不会被修改，导入过程可能需要几分钟。
          </p>
        </div>
        <div className="mt-6 flex shrink-0 flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
          >
            取消
          </button>
          {duplicateCount > 0 ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStart('skip')}
                className="min-h-11 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
              >
                跳过已存在（导入 {scan.newCount} 条）
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onStart('overwrite')}
                className="min-h-11 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
              >
                覆盖已存在（{duplicateCount} 条）
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onStart('skip')}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45 md:min-h-8"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              开始导入并重启
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
