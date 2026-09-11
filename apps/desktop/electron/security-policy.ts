import { isAbsolute, relative, resolve, sep } from 'path';
import { realpathSync, statSync } from 'fs';

/** Accept only the one application document (hash routing is intentionally allowed). */
export function isTrustedRendererUrl(value: string, rendererUrl: string): boolean {
  try {
    const actual = new URL(value);
    const expected = new URL(rendererUrl);
    return actual.origin === expected.origin && actual.protocol === expected.protocol &&
      actual.host === expected.host && actual.pathname === expected.pathname &&
      actual.search === expected.search && !actual.username && !actual.password;
  } catch { return false; }
}

export function assertTrustedSender(event: Electron.IpcMainInvokeEvent, window: Electron.BrowserWindow | null, rendererUrl: string): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      !event.senderFrame || !isTrustedRendererUrl(event.senderFrame.url, rendererUrl)) {
    throw new Error('This desktop request did not originate from the application window.');
  }
}

export function validateExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020]/.test(value)) throw new Error('Invalid external link.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw new Error('Only secure HTTPS links can be opened.');
  }
  return parsed.href;
}

export function validateDirectoryToOpen(value: unknown, dataDir: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Choose an application folder.');
  const folder = realpathSync(value);
  const root = realpathSync(dataDir);
  const child = relative(root, folder);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !statSync(folder).isDirectory()) {
    throw new Error('Only folders inside application data can be opened.');
  }
  return folder;
}

export function validateProfileOverride(value: string): string {
  if (!isAbsolute(value) || value.startsWith('\\\\') || value.startsWith('//') || value.includes('\0')) {
    throw new Error('The isolated application profile must be an absolute local directory.');
  }
  const result = resolve(value);
  if (resolve(result, '..') === result) throw new Error('The application profile cannot be a drive root.');
  return result;
}

const API_ROUTES: Array<[RegExp, readonly string[]]> = [
  [/^\/api\/v1\/auth\/(status|session)$/, ['GET']],
  [/^\/api\/v1\/auth\/(login|logout|change-password|revoke-other-sessions)$/, ['POST']],
  [/^\/api\/v1\/chat\/conversations(?:\/[\w-]+)?$/, ['GET', 'POST', 'PATCH', 'DELETE']],
  [/^\/api\/v1\/chat\/conversations\/[\w-]+\/messages$/, ['GET']],
  [/^\/api\/v1\/chat\/(completions|stop\/[\w-]+)$/, ['POST']],
  [/^\/api\/v1\/models(?:\/[\w-]+(?:\/(activate|deactivate))?)?$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/v1\/knowledge\/(collections|documents)(?:\/[\w-]+(?:\/(documents|reprocess))?)?$/, ['GET', 'POST', 'DELETE']],
  [/^\/api\/v1\/(knowledge|retrieval)\/search$/, ['POST']],
  [/^\/api\/v1\/admin\/(users(?:\/[\w-]+)?|roles|audit|jobs|health)$/, ['GET', 'POST', 'PATCH', 'DELETE']],
  [/^\/api\/v1\/jobs(?:\/[\w-]+(?:\/(retry|cancel))?)?$/, ['GET', 'POST']],
  [/^\/api\/v1\/settings$/, ['GET', 'PATCH']],
  [/^\/api\/v1\/system\/(data-paths|backup|restore)$/, ['GET', 'POST']],
  [/^\/api\/v1\/inference\/(chat\/completions|embeddings)$/, ['POST']],
];

export function validateProxyRequest(method: unknown, path: unknown, body?: unknown): { method: string; path: string; body?: string } {
  if (typeof method !== 'string' || typeof path !== 'string' || path.length > 8192 ||
      /[\\#\u0000-\u0020]/.test(path) || !path.startsWith('/api/v1/') || path.includes('..')) {
    throw new Error('Invalid local service route.');
  }
  const pathname = path.split('?')[0];
  // No encoded separators or identifiers: IDs are generated locally as UUIDs.
  if (pathname.includes('%') || !API_ROUTES.some(([route, methods]) => route.test(pathname) && methods.includes(method))) {
    throw new Error('This local service operation is not available through the desktop bridge.');
  }
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > 1024 * 1024) throw new Error('The request is too large.');
  if ((method === 'GET' || method === 'DELETE') && serialized !== undefined) throw new Error('This operation does not accept a request body.');
  return { method, path, body: serialized };
}
