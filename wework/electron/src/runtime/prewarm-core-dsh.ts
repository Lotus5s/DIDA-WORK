import { createCoreDshLaunch, prepareCoreDshRuntime } from './core-dsh-runtime.js'
import { DshRuntime } from './dsh-runtime.js'

export interface PrewarmCoreDshOptions {
  environment: NodeJS.ProcessEnv
  dataDirectory: string
  logDirectory: string
}

/**
 * Start the bundled DSH runtime once and stop it. Run by the installer so the
 * managed profile is copied, Node's compile cache is populated and the OS /
 * antivirus caches the freshly installed files before the first real launch.
 */
export async function prewarmCoreDsh(options: PrewarmCoreDshOptions): Promise<void> {
  const runtimeRoot = options.environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
  if (!runtimeRoot) throw new Error('WEWORK_HARNESS_RUNTIME_ROOT is not configured')
  if (!options.environment.WEWORK_CORE_PLUGIN_ROOT?.trim()) {
    throw new Error('WEWORK_CORE_PLUGIN_ROOT is not configured')
  }
  const prepared = await prepareCoreDshRuntime({
    runtimeRoot,
    dataDirectory: options.dataDirectory,
    environment: options.environment,
  })
  const launch = createCoreDshLaunch(prepared, 0)
  const runtime = new DshRuntime({
    url: 'http://127.0.0.1:0/',
    name: 'dsh-prewarm',
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.environment,
    logDirectory: options.logDirectory,
    logFileName: 'dsh-prewarm.log',
    startTimeoutMs: 120_000,
  })
  try {
    await runtime.start(120_000)
  } finally {
    await runtime.stop()
  }
}
