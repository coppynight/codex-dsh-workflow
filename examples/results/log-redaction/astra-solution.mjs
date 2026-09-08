// Credential alternatives are matched together so replacements are never rescanned.
const CREDENTIAL = /("(?:token|api_key|apiKey|password|secret)"\s*:\s*")((?:\\[^\r\n]|[^"\\\u0000-\u001f])*)(")|(\b[Bb][Ee][Aa][Rr][Ee][Rr][ \t]+)([A-Za-z0-9._~+\/=\-]+)|([?&](?:token|api_key|key|access_token)=)([^&\s#]*)|((?<![\p{L}\p{N}\p{M}_$])(?:token|api_key|password)=)(\S+)/gu;

export function redactLog(text) {
  if (typeof text !== 'string') {
    throw new TypeError('redactLog expects a string');
  }

  // A fresh regex keeps calls independent of mutable RegExp.lastIndex.
  return text.replace(new RegExp(CREDENTIAL.source, CREDENTIAL.flags),
    (match, jsonPrefix, jsonValue, jsonSuffix,
      bearerPrefix, bearerValue, queryPrefix, queryValue,
      assignmentPrefix, assignmentValue) => {
      if (jsonPrefix !== undefined) {
        return jsonPrefix + (jsonValue === '' ? '' : '[REDACTED]') + jsonSuffix;
      }
      if (bearerPrefix !== undefined) {
        return bearerPrefix + '[REDACTED]';
      }
      if (queryPrefix !== undefined) {
        return queryPrefix + (queryValue === '' ? '' : '[REDACTED]');
      }
      return assignmentPrefix + '[REDACTED]';
    });
}
