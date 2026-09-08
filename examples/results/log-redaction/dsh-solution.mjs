// redactLog: pure, dependency-free credential redaction for log text.
//
// Replaces credential VALUES with [REDACTED] while preserving keys,
// punctuation, whitespace/newlines and all unrelated text. Empty values are
// left unchanged, and the transformation is idempotent (applying it twice
// yields the same output). No I/O of any kind is performed.

const REDACTED = '[REDACTED]';

// 1) Bearer tokens — the keyword is matched case-insensitively and its
//    original spelling plus the original whitespace run are rebuilt, so
//    only the token value itself (letters/digits/._~+/-=) is replaced.
const BEARER_RE = /\b(bearer)(\s+)([A-Za-z0-9._~+/=-]+)/gi;

// 2) JSON members whose double-quoted key is exactly token, api_key, apiKey,
//    password or secret and whose value is a double-quoted string (escaped
//    quotes/backslashes included). The value must be non-empty, so
//    {"token": ""} is preserved unchanged.
const JSON_KEY_RE =
  /("(?:token|api_key|apiKey|password|secret)"\s*:\s*")((?:[^"\\]|\\.)+)(")/g;

// 3) Query-parameter / assignment forms key=value for the exact standalone
//    keys token, api_key, key, access_token, password. The key may not be
//    glued to a preceding word character (protects monkey=banana and
//    token_count=23), and the value runs up to the next & / whitespace / #
//    (so percent-encoded content is fully covered). Empty values (key=)
//    are left unchanged.
const ASSIGN_RE =
  /(?<![A-Za-z0-9_])(token|api_key|key|access_token|password)(=)([^\s&#]+)/g;

export function redactLog(text) {
  if (typeof text !== 'string') {
    throw new TypeError('redactLog expects a string argument');
  }

  return text
    .replace(BEARER_RE, (match, keyword, whitespace) => keyword + whitespace + REDACTED)
    .replace(JSON_KEY_RE, (match, head, value, tail) => head + REDACTED + tail)
    .replace(ASSIGN_RE, (match, key, equals) => key + equals + REDACTED);
}
