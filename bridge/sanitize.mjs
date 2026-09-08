// Error hygiene for the portable DSH bridge.
//
// The bridge never echoes authentication URLs (one-time token URLs), cookies,
// or provider error payloads that may embed credentials. Every message that
// leaves the bridge toward a caller is run through redact() and, for RPC
// failures, through rpcErrorMessage(), which substitutes model/provider
// guidance for upstream messages on those code paths.
const KEY_PATTERN = /(\b(?:token|api[_-]?key|apikey|secret|password|passwd|cookie|authorization|credential|access[_-]?token|refresh[_-]?token)\b)([=:]\s*)([^&\s"'<>`]{4,})/gi;
const QUERY_PATTERN = /(\?[^#\s"'<>`]*?)([?&](?:token|key|auth|code|signature|sig)=)[^&#\s"'<>`]*/gi;
const AUTH_SCHEME_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SK_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/gi;
const LONG_HEX_PATTERN = /\b[0-9a-fA-F]{40,}\b/g;
const LONG_B64_PATTERN = /\b[A-Za-z0-9+/]{48,}={0,2}\b/g;

/** Remove credential-shaped fragments from a free-form string. */
export function redact(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(KEY_PATTERN, '$1$2[redacted]')
    .replace(QUERY_PATTERN, '$1[redacted-query]')
    .replace(AUTH_SCHEME_PATTERN, '[redacted-credentials]')
    .replace(SK_PATTERN, '[redacted-key]')
    .replace(LONG_HEX_PATTERN, '[redacted]')
    .replace(LONG_B64_PATTERN, '[redacted]');
}

/** Actionable guidance for provider/model trouble; never asks for keys. */
export const MODEL_GUIDANCE =
  'Resolve this in DSH Web > Settings > Models (provider credentials live there and never travel through this bridge).';

/** Codes whose free-form messages may embed provider/credential details. */
const SENSITIVE_CODE = /model|provider|credential|api[-_]?key|token|auth|billing|quota|rate|key/i;

/** Compose the caller-facing message for one RPC failure. */
export function rpcErrorMessage(code, message, { endpoint, write = false } = {}) {
  const suffix = endpoint ? ` for ${endpoint}` : '';
  if (write) {
    return `DSH ${code || 'request failed'}${suffix}; writes are not automatically retried.`;
  }
  if (SENSITIVE_CODE.test(code || '')) {
    return `DSH ${code || 'request failed'}${suffix}. ${MODEL_GUIDANCE}`;
  }
  const safe = redact(message || '').slice(0, 400).trim();
  return `DSH ${code || 'request failed'}${suffix}: ${safe || 'no details provided by the Host.'}`;
}

/** Compose the caller-facing message for one local failure (already trusted). */
export function localErrorMessage(message) {
  return redact(message instanceof Error ? message.message : String(message)).slice(0, 600);
}
