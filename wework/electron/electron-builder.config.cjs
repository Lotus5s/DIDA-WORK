const path = require('node:path')
const fs = require('node:fs/promises')

const { resolveBuildIdentity } = require('./scripts/build-identity.cjs')
const macosAppIcon = require('./scripts/macos-app-icon.cjs')
const verifyWindowsMigrationLock = require('./scripts/verify-windows-migration-lock.cjs')

const updateBaseUrl =
  process.env.WEWORK_UPDATE_BASE_URL ||
  'https://github.com/Lotus5s/DIDA-WORK/releases/download/dida-work-updater'
const identity = resolveBuildIdentity()
const useCustomMacosNotarization =
  process.env.WEWORK_CUSTOM_MACOS_NOTARIZATION?.trim().toLowerCase() === 'true'
const onlineUpdateBuild = process.env.WEWORK_ONLINE_UPDATE_BUILD?.trim().toLowerCase() === 'true'
const onlineUpdateIncludesComponents =
  process.env.WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS?.trim().toLowerCase() === 'true'
const artifactPrefix = onlineUpdateBuild ? 'DIDAWorkHostUpdate' : 'DIDAWork'
const didaUpdaterCacheDirName = 'io.wecode.dida-work-updater'
const managedComponentResources = [
  { from: 'resources/harness-runtime', to: 'harness-runtime' },
  { from: 'resources/bin', to: 'bin' },
  { from: 'resources/codex', to: 'codex' },
  { from: 'resources/wework-core-plugins', to: 'wework-core-plugins' },
  { from: 'resources/wework-app-static', to: 'wework-app-static' },
  { from: 'resources/bundled-plugins', to: 'bundled-plugins' },
]

module.exports = {
  appId: identity.identifier,
  protocols: [{ name: 'DIDA Work', schemes: ['wework'] }],
  productName: identity.productName,
  executableName: identity.executableName,
  compression: 'normal',
  beforePack: macosAppIcon.prepare,
  afterPack: async context => {
    await verifyWindowsMigrationLock(context)
    if (context.electronPlatformName !== 'win32') return
    const updateConfigPath = path.join(context.appOutDir, 'resources', 'app-update.yml')
    try {
      const updateConfig = await fs.readFile(updateConfigPath, 'utf8')
      await fs.writeFile(
        updateConfigPath,
        updateConfig.replace(
          /^updaterCacheDirName:.*$/m,
          `updaterCacheDirName: ${didaUpdaterCacheDirName}`
        )
      )
    } catch {
      // The update config is generated only for packaged desktop targets.
    }
  },
  extraMetadata: {
    name: identity.packageName,
    weworkUpdateBaseUrl: updateBaseUrl,
    weworkAppId: identity.identifier,
    weworkProductName: identity.productName,
    weworkExecutableName: identity.executableName,
    ...(identity.executorNamespace ? { weworkExecutorNamespace: identity.executorNamespace } : {}),
    ...(identity.backendUrl ? { weworkBackendUrl: identity.backendUrl } : {}),
    ...(identity.socketUrl ? { weworkSocketUrl: identity.socketUrl } : {}),
  },
  directories: {
    buildResources: 'build',
    output: onlineUpdateBuild ? 'release-online-update' : 'release-installer',
  },
  files: ['dist/**/*', 'package.json'],
  asar: true,
  asarUnpack: ['**/*.{node,dylib,so,dll}'],
  extraResources: [
    ...(!onlineUpdateBuild || onlineUpdateIncludesComponents ? managedComponentResources : []),
    { from: 'resources/components.json', to: 'components.json' },
    { from: '../resources/licenses', to: 'licenses' },
    { from: '../resources/icons', to: 'icons' },
    { from: '../../LICENSE', to: 'LICENSE' },
  ],
  publish: {
    provider: 'generic',
    url: updateBaseUrl,
  },
  ...(useCustomMacosNotarization
    ? { afterSign: path.resolve(__dirname, 'scripts/notarize-macos.cjs') }
    : {}),
  mac: {
    artifactName: `${artifactPrefix}_\${version}_macos_\${arch}.\${ext}`,
    category: 'public.app-category.developer-tools',
    electronLanguages: ['en', 'zh_CN'],
    hardenedRuntime: true,
    entitlements: path.resolve(__dirname, 'entitlements.mac.plist'),
    entitlementsInherit: path.resolve(__dirname, 'entitlements.mac.plist'),
    extendInfo: {
      ...macosAppIcon.extendInfo,
      NSMicrophoneUsageDescription: `${identity.productName} uses the microphone to record audio when you use voice features.`,
    },
    ...(useCustomMacosNotarization ? { notarize: false } : {}),
    icon: macosAppIcon.icon,
    extraFiles: [{ from: macosAppIcon.assetCatalog, to: 'Resources/Assets.car' }],
    signIgnore: process.env.APPLE_SIGNING_IDENTITY
      ? managedComponentResources.map(resource => '/Contents/Resources/' + resource.to + '/')
      : ['/Contents/Resources/wework-core-plugins/'],
    target: onlineUpdateBuild ? ['zip'] : ['dmg', 'zip'],
  },
  dmg: {
    sign: false,
    writeUpdateInfo: false,
  },
  win: {
    // Desktop data migration runs before managed components can be resolved.
    extraResources:
      onlineUpdateBuild && !onlineUpdateIncludesComponents
        ? [{ from: 'resources/bin/wegent-executor.exe', to: 'bin/wegent-executor.exe' }]
        : [],
    artifactName: `${onlineUpdateBuild ? 'DIDA Work Update' : 'DIDA Work'} \${version} Windows \${arch}${onlineUpdateBuild ? '' : ' Setup'}.\${ext}`,
    electronLanguages: ['en-US', 'zh-CN'],
    icon: path.resolve(__dirname, '../resources/icons/icon.ico'),
    target: ['nsis'],
  },
  nsis: {
    oneClick: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
  linux: {
    artifactName: `${artifactPrefix}_\${version}_linux_\${arch}.\${ext}`,
    category: 'Development',
    electronLanguages: ['en-US', 'zh-CN'],
    target: ['AppImage'],
  },
}
