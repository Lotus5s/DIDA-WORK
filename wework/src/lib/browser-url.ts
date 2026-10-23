function isLocalAssetUrl(url: URL): boolean {
  return url.protocol === 'asset:' && url.hostname === 'localhost'
}

function encodeFilePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function encodeFilePath(path: string): string {
  return path
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[a-zA-Z]:$/.test(segment)) return segment
      return encodeFilePathSegment(segment)
    })
    .join('/')
}

function localPathToFileUrl(value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null

  if (/^\\\\/.test(normalized)) {
    const uncPath = normalized.replace(/^\\\\+/, '').replace(/\\/g, '/')
    const [host, ...segments] = uncPath.split('/')
    if (!host || segments.length === 0) return null
    return `file://${host}/${segments.map(encodeFilePathSegment).join('/')}`
  }

  if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    return `file:///${encodeFilePath(normalized.replace(/\\/g, '/'))}`
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeFilePath(normalized.replace(/\\/g, '/'))}`
  }

  return null
}

export function browserDiagnosticOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol
  } catch {
    return null
  }
}

const BROWSER_SEARCH_URL = 'https://www.bing.com/search?q='

function isSingleLabelHost(value: string): boolean {
  return (
    /^[a-z0-9-]+$/i.test(value) &&
    value.toLowerCase() !== 'localhost' &&
    !/^\d+$/.test(value)
  )
}

/** Add .com when the user typed a single word such as "google". */
function withDefaultDomain(value: string): string {
  return isSingleLabelHost(value) ? `${value}.com` : value
}

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const localFileUrl = localPathToFileUrl(trimmed)
  if (localFileUrl) return localFileUrl

  // Free text without a scheme is a search, not a host name. Explicit URLs
  // (including file URLs with spaces or non-ASCII paths) keep their meaning.
  const hasExplicitScheme = /^[a-z][a-z\d+\-.]*:/i.test(trimmed)
  if (!hasExplicitScheme && (/\s/.test(trimmed) || /[^\x00-\x7F]/.test(trimmed))) {
    return `${BROWSER_SEARCH_URL}${encodeURIComponent(trimmed)}`
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${withDefaultDomain(trimmed)}`

  try {
    const url = new URL(withProtocol)
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'file:' &&
      !isLocalAssetUrl(url)
    ) {
      return null
    }
    // "http://google" parses successfully but cannot resolve; complete the
    // host name the same way the address bar does.
    if (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      isSingleLabelHost(url.hostname)
    ) {
      url.hostname = `${url.hostname}.com`
    }
    return url.toString()
  } catch {
    return null
  }
}
