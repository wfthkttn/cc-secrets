/** A name or code as a runtime sets it; anything else might be text from the request. */
const LABEL = /^[A-Za-z][A-Za-z0-9_]{1,39}$/

/**
 * What a failed relay call met, from the error's type and code alone: the error's text may
 * carry the request, and with it the secret. A system code found in that text (ECONNREFUSED)
 * is kept, as it carries nothing else.
 */
export function failureKind(error: unknown): string {
  if (!(error instanceof Error)) return 'no error type'
  const parts: string[] = []
  if (LABEL.test(error.name)) parts.push(error.name)
  const code = (error as { code?: unknown }).code
  const systemCode = /\bE[A-Z]{2,}\b/.exec(error.message)?.[0]
  if (typeof code === 'string' && LABEL.test(code)) parts.push(code)
  else if (systemCode !== undefined) parts.push(systemCode)
  return parts.length === 0 ? 'no error type' : parts.join(', ')
}
