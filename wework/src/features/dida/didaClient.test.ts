import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ProviderModel } from '../../../electron/src/host/model-configuration-contract'

const mocks = vi.hoisted(() => ({
  invokeDesktopHost: vi.fn(),
  saveProviderConfiguration: vi.fn(),
}))

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: mocks.invokeDesktopHost }))
vi.mock('@/features/model-settings/providerModelConfiguration', () => ({
  saveProviderConfiguration: mocks.saveProviderConfiguration,
}))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: () => true }))

import { syncDidaModels } from './didaClient'
import {
  createDefaultLocalModelCatalogEntry,
  DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS,
} from '@/features/model-settings/localModelCatalog'

function entry(id: string, modelId: string, displayName: string): ProviderModel {
  const contextWindow = 1_048_576
  return {
    id,
    model_id: modelId,
    display_name: displayName,
    provider_profile_id: 'dida',
    api_format: 'openai-responses',
    request_path: '/responses',
    tool_profile: 'custom',
    codex_tool_compatibility: 'native',
    context_window: contextWindow,
    catalog_entry: {
      ...createDefaultLocalModelCatalogEntry({
        id,
        displayName,
        toolProfile: 'custom',
        contextWindow,
      }),
      base_instructions: `${DEFAULT_CUSTOM_MODEL_BASE_INSTRUCTIONS}\n\nThe upstream model serving this session is ${displayName} (model id: ${modelId}). When asked which model you are, identify yourself as ${displayName}.

The desktop application hosting this session is DIDA Work. Its former names Wework and WeWork are obsolete; never call the application Wework or WeWork. When you refer to the application, call it DIDA Work.`,
    },
    enabled: true,
  }
}

function snapshot(models: ProviderModel[]) {
  return {
    path: 'model.yml',
    revision: 'revision-1',
    loadedAt: '2026-10-23T00:00:00.000Z',
    providers: [
      {
        id: 'dida',
        name: 'DIDA',
        base_url: 'https://zz.didadida.dpdns.org',
        api_format: 'openai-responses',
        request_path: '/responses',
        models_path: '/models',
        api_key_ref: 'wework-model-key.dida',
        api_key_configured: true,
        enabled: true,
        models,
      },
    ],
  }
}

const discovered = [
  { id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
  { id: 'gpt-6-sol', displayName: 'GPT-6 Sol' },
  { id: 'gpt-6-astra', displayName: 'GPT-6 Astra' },
  { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
  { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
  { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna' },
  { id: 'gpt-6-luna', displayName: 'GPT-6 Luna' },
  { id: 'codex-auto-review', displayName: 'Codex Auto Review' },
  { id: 'gpt-image-1', displayName: 'GPT Image 1' },
]

describe('syncDidaModels', () => {
  beforeEach(() => {
    mocks.invokeDesktopHost.mockReset()
    mocks.saveProviderConfiguration.mockReset()
  })

  test('keeps the current selection, appends new models and drops removed ones', async () => {
    const stale = [
      entry('gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol'),
      entry('gpt-6', 'gpt-6', 'GPT-6 (Astra)'),
      entry('gpt-5-6', 'gpt-5.6', 'GPT-5.6 (Sol)'),
      entry('gpt-5-4', 'gpt-5.4', 'GPT-5.4'),
      entry('gpt-5-4-mini', 'gpt-5.4-mini', 'GPT-5.4 Mini'),
    ]
    mocks.invokeDesktopHost.mockImplementation((capability: string) => {
      if (capability === 'modelConfiguration.read') return Promise.resolve(snapshot(stale))
      if (capability === 'modelConfiguration.discoverModels')
        return Promise.resolve(discovered)
      return Promise.reject(new Error(`Unexpected capability: ${capability}`))
    })

    const result = await syncDidaModels({ force: true })

    expect(result).toEqual({
      updated: true,
      models: 7,
      added: [
        'gpt-6-sol',
        'gpt-6-astra',
        'gpt-5.6-sol',
        'gpt-5.6-terra',
        'gpt-5.6-luna',
        'gpt-6-luna',
      ],
      removed: ['gpt-6', 'gpt-5.6', 'gpt-5.4', 'gpt-5.4-mini'],
    })
    expect(mocks.saveProviderConfiguration).toHaveBeenCalledTimes(1)
    const [revision, providers] = mocks.saveProviderConfiguration.mock.calls[0]
    expect(revision).toBe('revision-1')
    expect(providers[0].models.map((model: ProviderModel) => model.id)).toEqual([
      'gpt-6-1-sol',
      'gpt-6-sol',
      'gpt-6-astra',
      'gpt-5-6-sol',
      'gpt-5-6-terra',
      'gpt-5-6-luna',
      'gpt-6-luna',
    ])
    expect(
      providers[0].models.map((model: ProviderModel) => model.model_id)
    ).not.toEqual(expect.arrayContaining(['gpt-image-1', 'codex-auto-review']))
    expect(providers[0].api_key_ref).toBe('wework-model-key.dida')
  })

  test('does not rewrite the configuration when the allowlist is unchanged', async () => {
    const current = [
      entry('gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol'),
      entry('gpt-6-sol', 'gpt-6-sol', 'GPT-6 Sol'),
    ]
    mocks.invokeDesktopHost.mockImplementation((capability: string) => {
      if (capability === 'modelConfiguration.read') return Promise.resolve(snapshot(current))
      if (capability === 'modelConfiguration.discoverModels')
        return Promise.resolve(discovered.slice(0, 2))
      return Promise.reject(new Error(`Unexpected capability: ${capability}`))
    })

    const result = await syncDidaModels({ force: true })

    expect(result).toEqual({ updated: false, models: 2, added: [], removed: [] })
    expect(mocks.saveProviderConfiguration).not.toHaveBeenCalled()
  })

  test('never wipes a working configuration when discovery returns nothing', async () => {
    mocks.invokeDesktopHost.mockImplementation((capability: string) => {
      if (capability === 'modelConfiguration.read')
        return Promise.resolve(snapshot([entry('gpt-6-1-sol', 'gpt-6.1-sol', 'GPT-6.1 Sol')]))
      if (capability === 'modelConfiguration.discoverModels') return Promise.resolve([])
      return Promise.reject(new Error(`Unexpected capability: ${capability}`))
    })

    const result = await syncDidaModels({ force: true })

    expect(result.updated).toBe(false)
    expect(mocks.saveProviderConfiguration).not.toHaveBeenCalled()
  })
})
