// Runtime bootstrap for the portable DSH bridge.
//
// All bridge modules obtain machine-specific facts exclusively through
// scripts/config.mjs (see its loadConfig contract). Nothing in bridge/ may
// hardcode an install location, host origin, workspace root, model, or time
// zone: validateConfig() checks the supplied configuration once, derives the
// HTTP/WS URLs, and loadDescriptors() lazily resolves the official DSH remote
// descriptors from the configured dsh.installDir.
import { loadConfig } from '../scripts/config.mjs';
import { createRequire } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

function invalid(field, detail) {
  throw new Error(`scripts/config.mjs is invalid: ${field} ${detail}`);
}

function parseOrigin(value) {
  if (typeof value !== 'string' || value.length === 0) invalid('dsh.origin', 'must be a non-empty string.');
  let url;
  try { url = new URL(value); } catch { invalid('dsh.origin', 'is not a valid URL.'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    invalid('dsh.origin', 'must be exactly http://127.0.0.1:<port> with no path, credentials, query, or fragment.');
  }
  return url;
}

function absolutePath(value, field) {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    invalid(field, 'must be an absolute path string.');
  }
  return value;
}

/**
 * Validate one config object (the loadConfig contract shape) and derive every
 * runtime value the bridge needs. Throws with field-level guidance when the
 * config is malformed. Pure and synchronous so tests can exercise it offline.
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object') invalid('', 'loadConfig() must return an object.');
  const dsh = config.dsh && typeof config.dsh === 'object' ? config.dsh : invalid('dsh', 'is missing.');
  const modelSelection = dsh.model && typeof dsh.model === 'object' ? dsh.model : invalid('dsh.model', 'is missing.');
  if (typeof config.timeZone !== 'string' || !config.timeZone) invalid('timeZone', 'must be a non-empty string.');
  if (typeof modelSelection.provider !== 'string' || !modelSelection.provider) invalid('dsh.model.provider', 'must be a non-empty string.');
  if (typeof modelSelection.model !== 'string' || !modelSelection.model) invalid('dsh.model.model', 'must be a non-empty string.');
  if (modelSelection.reasoningEffort !== undefined && (typeof modelSelection.reasoningEffort !== 'string' || !modelSelection.reasoningEffort)) {
    invalid('dsh.model.reasoningEffort', 'must be a non-empty string when present.');
  }
  const workspaceRoots = dsh.workspaceRoots;
  if (!Array.isArray(workspaceRoots) || workspaceRoots.some((root) => typeof root !== 'string' || root.length === 0 || !isAbsolute(root))) {
    invalid('dsh.workspaceRoots', 'must be an array of absolute path strings (may be empty to disable delegation).');
  }
  const originUrl = parseOrigin(dsh.origin);
  const muxUrl = new URL('/api/remote.mux', originUrl);
  muxUrl.protocol = muxUrl.protocol === 'http:' ? 'ws:' : 'wss:';
  const resolvedLogPath = (() => {
    const value = dsh.logPath;
    if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
      invalid('dsh.logPath', 'must be an absolute path string (or set DSH_HOST_STARTUP_LOG).');
    }
    return value;
  })();
  return {
    origin: originUrl.origin,
    apiUrl: (endpoint) => new URL(`/api/${endpoint}`, originUrl).href,
    muxWebSocketUrl: muxUrl.href,
    installDir: absolutePath(dsh.installDir, 'dsh.installDir'),
    logPath: resolvedLogPath,
    stateDir: absolutePath(dsh.stateDir, 'dsh.stateDir'),
    model: { provider: modelSelection.provider, model: modelSelection.model, ...(modelSelection.reasoningEffort ? { reasoningEffort: modelSelection.reasoningEffort } : {}) },
    timeZone: config.timeZone,
    configuredRoots: [...workspaceRoots],
  };
}

const runtime = validateConfig(loadConfig());

/** http://127.0.0.1:<port> of the configured DSH Host (validated, no token). */
export const origin = runtime.origin;
/** URL of one authenticated RPC endpoint on the configured Host. */
export const apiUrl = runtime.apiUrl;
/** Derived WebSocket URL of the remote mux (http -> ws on the same origin). */
export const muxWebSocketUrl = runtime.muxWebSocketUrl;
/** Directory that owns the official DSH packages (has package.json + node_modules). */
export const installDir = runtime.installDir;
/** Startup log the Host writes its one-time auth URL into. */
export const logPath = runtime.logPath;
/** Persistent state directory (claims, records, locks) — kept outside the bridge repo. */
export const stateDir = runtime.stateDir;
/** Configured delegated model selection; never changed silently. */
export const model = runtime.model;
/** IANA time zone forwarded on every prompt. */
export const timeZone = runtime.timeZone;
/** Configured workspace roots verbatim (canonicalized by the service before containment checks). */
export const configuredRoots = runtime.configuredRoots;

/** True when the configured installDir actually carries the official remote descriptors. */
export function descriptorsAvailable() {
  return existsSync(join(installDir, 'package.json')) &&
    existsSync(join(installDir, 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'package.json'));
}

let descriptorsPromise;
/** Lazy loader for the official DSH remote descriptors (TYPERT_REMOTE). */
export function loadDescriptors() {
  if (!descriptorsPromise) {
    descriptorsPromise = (async () => {
      const pkg = join(installDir, 'package.json');
      if (!existsSync(pkg)) {
        throw new Error('DSH remote descriptors are unavailable: dsh.installDir in the user configuration does not contain package.json. Point dsh.installDir at the directory that owns the DSH install.');
      }
      const requireDsh = createRequire(pkg);
      let resolved;
      try { resolved = requireDsh.resolve('@deepseek-ai/dsh-api-session-controller/remote'); }
      catch (error) {
        throw new Error(`DSH remote descriptors are unavailable: '@deepseek-ai/dsh-api-session-controller' was not found under dsh.installDir in the user configuration (${error && error.code ? error.code : 'resolution failed'}). Reinstall DSH there or fix dsh.installDir.`);
      }
      const imported = await import(pathToFileURL(resolved).href);
      const typert = imported.TYPERT_REMOTE || imported.default;
      if (!typert || !Array.isArray(typert.descriptors)) {
        throw new Error('DSH remote descriptors are unavailable: the resolved module did not export TYPERT_REMOTE.descriptors.');
      }
      return typert;
    })();
  }
  return descriptorsPromise;
}

/** Best-effort DSH version reported by the configured install, or null. */
export async function readInstalledDshVersion() {
  try {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(join(installDir, 'package.json'), 'utf8'));
    const direct = pkg.dependencies && pkg.dependencies['@deepseek-ai/dsh'];
    if (typeof direct === 'string') return direct.replace(/^[\^~>=< ]+/, '');
    if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    return null;
  } catch { return null; }
}
