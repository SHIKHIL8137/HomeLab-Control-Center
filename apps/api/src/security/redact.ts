const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|api[-_]?key|access[-_]?key|private|cookie|authorization|credential/i;
const MASK = '[REDACTED]';

/** Masks credentials in free text (log lines, error messages) before it is stored or shown. */
export function redactText(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK)
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]+/gi, `$1: ${MASK}`)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${MASK}`)
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`)
    .replace(
      /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\s*[=:]\s*("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      `$1=${MASK}`,
    );
}

/** Deep-copies a value, masking anything under a sensitive-looking key and scrubbing strings. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return MASK;
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? MASK : redactValue(v, depth + 1),
      ]),
    );
  }
  return value;
}
