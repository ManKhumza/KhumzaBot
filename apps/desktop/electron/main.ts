import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import { IPC } from '../shared/ipc-contract';
import type {
  ChatLoadPayload,
  ChatSendPayload,
  KnowledgeUploadPayload,
  RenamePayload,
  ReprocessPayload,
} from '../shared/ipc-contract';
import { basename, join } from 'path';
import { spawn, SpawnOptions } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync, statSync } from 'fs';
const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;
let backendProcess: ReturnType<typeof spawn> | null = null;
let backendToken: string | null = null;
let sessionToken: string | null = null;
let backendPort: number | null = null;
let isShuttingDown = false;
let lastRendererRecoveryAt = 0;
let unresponsiveDialogOpen = false;
let backendStartupPromise: Promise<void> | null = null;
const nativeFetch = globalThis.fetch;

async function getResponseError(response: Response): Promise<Error> {
  const fallback = `Local service request failed (${response.status})`;
  let body = '';
  try {
    body = await response.text();
    const parsed = JSON.parse(body) as { detail?: unknown; message?: unknown };
    if (typeof parsed.detail === 'string') return new Error(parsed.detail);
    if (typeof parsed.message === 'string') return new Error(parsed.message);
    if (Array.isArray(parsed.detail)) {
      const messages = parsed.detail
        .map((item) => typeof item === 'object' && item && 'msg' in item ? String(item.msg) : '')
        .filter(Boolean);
      if (messages.length) return new Error(messages.join('. '));
    }
  } catch {
    // A non-JSON response is handled below without exposing an HTML error page.
  }
  return new Error(body && !body.trimStart().startsWith('<') ? body : fallback);
}

/** Add the private Electron-to-backend credential to every loopback call. */
async function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  if (backendStartupPromise) await backendStartupPromise;
  const headers = new Headers(init.headers);
  if (backendToken) headers.set('X-NOC-AI-Backend-Token', backendToken);
  const response = await nativeFetch(input, { ...init, headers });
  if (!response.ok) throw await getResponseError(response);
  return response;
}

async function createWindow(): Promise<BrowserWindow> {
  // Security: Disable remote module, enable sandbox
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 768,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#000000',
      height: 32,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload/preload.js'),
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      spellcheck: false,
    },
  });
  const window = mainWindow;

  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.warn(`[renderer] ${message} (${sourceId}:${line})`);
  });

  window.webContents.on('render-process-gone', (_event, details) => {
    if (isShuttingDown || window.isDestroyed() || details.reason === 'clean-exit') return;
    console.error('Renderer process exited unexpectedly', details);
    const now = Date.now();
    if (now - lastRendererRecoveryAt > 15000) {
      lastRendererRecoveryAt = now;
      setTimeout(() => {
        if (!window.isDestroyed()) window.reload();
      }, 250);
      return;
    }
    void dialog.showMessageBox(window, {
      type: 'error',
      title: 'NOC AI Assistant recovered from a display failure',
      message: 'The interface stopped unexpectedly more than once.',
      detail: 'Your local data is intact. Reload the interface to continue.',
      buttons: ['Reload interface', 'Close application'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !window.isDestroyed()) window.reload();
      else if (response !== 0) void shutdown();
    });
  });

  window.on('unresponsive', () => {
    if (isShuttingDown || window.isDestroyed() || unresponsiveDialogOpen) return;
    unresponsiveDialogOpen = true;
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'NOC AI Assistant is taking longer than expected',
      message: 'The interface is not responding yet.',
      detail: 'A large local operation may still be running. You can wait or reload only the interface.',
      buttons: ['Wait', 'Reload interface'],
      defaultId: 0,
      cancelId: 0,
    }).then(({ response }) => {
      unresponsiveDialogOpen = false;
      if (response === 1 && !window.isDestroyed()) window.reload();
    });
  });

  // Block all navigation except explicit allow-list
  const ALLOWED_URLS = [
    'http://127.0.0.1:*',
    'file://*',
  ];

  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = ALLOWED_URLS.some(pattern => {
      const regex = new RegExp('^' + pattern.replace('*', '.*') + '$');
      return regex.test(url);
    });
    if (!allowed) {
      e.preventDefault();
    }
  });

  // Block new-window creation
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Strict CSP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "font-src 'self' data:; " +
          "connect-src 'self' http://127.0.0.1:*; " +
          "frame-ancestors 'none'; " +
          "base-uri 'self'; " +
          "form-action 'none';"
        ],
      },
    });
  });

  if (isDev) {
    await mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (event) => {
    if (!isShuttingDown) {
      event.preventDefault();
      void shutdown();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function getRandomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function findBackendCommand(): { command: string; prefixArgs: string[]; cwd: string; llamaPath: string; bundledModelsPath: string } {
  if (app.isPackaged) {
    const command = join(process.resourcesPath, 'python', 'python.exe');
    if (!existsSync(command)) throw new Error(`Backend Python runtime not found: ${command}`);
    return {
      command,
      prefixArgs: ['-m', 'backend.main'],
      cwd: join(process.resourcesPath, 'python'),
      llamaPath: join(process.resourcesPath, 'llama', 'llama-server.exe'),
      bundledModelsPath: join(process.resourcesPath, 'models'),
    };
  }

  const projectRoot = join(__dirname, '../../../../..');
  const command = join(projectRoot, '.venv', 'Scripts', 'python.exe');
  if (!existsSync(command)) throw new Error(`Python environment not found: ${command}`);
  return {
    command,
    prefixArgs: ['-m', 'backend.main'],
    cwd: projectRoot,
    llamaPath: join(projectRoot, 'runtimes', 'llama', 'llama-server.exe'),
    bundledModelsPath: join(projectRoot, 'resources', 'models'),
  };
}

async function startBackend(): Promise<number> {
  backendToken = randomBytes(32).toString('hex');
  backendPort = await getRandomPort();
  
  const backend = findBackendCommand();
  const dataDir = getDataDir();
  
  const args = [...backend.prefixArgs,
    '--port', String(backendPort),
    '--host', '127.0.0.1',
    '--data-dir', dataDir,
    '--log-level', 'info',
  ];

  const options: SpawnOptions = {
    cwd: backend.cwd,
    env: {
      ...process.env,
      NOC_AI_SESSION_TOKEN: backendToken,
      NOC_AI_DATA_DIR: dataDir,
      NOC_AI_MODELS_DIR: join(dataDir, 'models'),
      NOC_AI_KNOWLEDGE_DIR: join(dataDir, 'knowledge'),
      NOC_AI_LLAMA_SERVER_PATH: backend.llamaPath,
      NOC_AI_BUNDLED_MODELS_DIR: backend.bundledModelsPath,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  console.log(`Starting backend executable: ${backend.command}`);

  const processHandle = spawn(backend.command, args, options);
  backendProcess = processHandle;

  processHandle.stdout?.on('data', (data) => {
    console.log(`[backend] ${data.toString().trim()}`);
  });
  processHandle.stderr?.on('data', (data) => {
    console.warn(`[backend:stderr] ${data.toString().trim()}`);
  });

  processHandle.on('exit', (code, signal) => {
    console.log(`Backend exited: code=${code}, signal=${signal}`);
    backendProcess = null;
    if (!isShuttingDown && mainWindow) {
      mainWindow.webContents.send('backend:crashed', { code, signal });
    }
  });

  processHandle.on('error', (err) => {
    console.error('Backend process error', err);
    if (mainWindow) {
      mainWindow.webContents.send('backend:error', { message: err.message });
    }
  });

  // Wait for port to be listening
  // First launch may need to copy and initialize the bundled embedding model.
  await waitForPort(backendPort!, 60000);
  
  return backendPort!;
}

async function waitForPort(port: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!backendProcess) {
      throw new Error('Backend exited before opening its local port');
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const net = require('net');
        const socket = net.createConnection(port, '127.0.0.1');
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', reject);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`Port ${port} not available after ${timeout}ms`);
}

function getDataDir(): string {
  const base = process.env.APPDATA || process.env.HOME || '.';
  return join(base, 'NOC AI Assistant');
}

async function checkBackendHealth(): Promise<void> {
  const maxRetries = 30;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await nativeFetch(`http://127.0.0.1:${backendPort}/health/ready`, {
        headers: { 'X-NOC-AI-Backend-Token': backendToken || '' },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const health = await response.json() as { status?: string };
        if (health.status === 'ready') {
          return;
        }
      }
    } catch {
      // Retry
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Backend health check timeout');
}

async function startBackendUntilReady(): Promise<void> {
  await startBackend();
  await checkBackendHealth();
}

async function restartBackendService(): Promise<void> {
  const restartPromise = (async () => {
    await stopBackend();
    await startBackendUntilReady();
  })();
  backendStartupPromise = restartPromise;
  await restartPromise;
}

async function shutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Shutting down...');
  
  if (mainWindow) {
    mainWindow.webContents.send('app:shutting-down');
  }
  
  await stopBackend();
  
  if (mainWindow) {
    mainWindow.destroy();
    mainWindow = null;
  }
  
  app.exit(0);
}

async function stopBackend(): Promise<void> {
  if (!backendProcess) return;
  const backendPid = backendProcess.pid;
  try {
    await fetch(`http://127.0.0.1:${backendPort}/internal/prepare-shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    console.warn('Backend pre-shutdown cleanup failed', error);
  }
  if (process.platform === 'win32' && backendPid) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill.exe', ['/PID', String(backendPid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else {
    backendProcess?.kill('SIGTERM');
  }
  await waitForExit(5000);
}

async function waitForExit(timeout: number): Promise<void> {
  return new Promise((resolve) => {
    if (!backendProcess) return resolve();
    const timer = setTimeout(() => {
      backendProcess?.kill('SIGKILL');
      resolve();
    }, timeout);
    backendProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// IPC Handlers
function setupIpcHandlers(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion());
  
  ipcMain.handle('app:getBackendPort', () => backendPort);
  
  ipcMain.handle('backend:restart', async () => {
    await restartBackendService();
    return { success: true };
  });
  
  // Forward backend API calls
  ipcMain.handle('backend:request', async (event, { method, path, body }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    
    if (!response.ok) {
      const error = await response.text();
      throw new Error(error);
    }
    
    return response.json();
  });
  
  // File dialogs
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory'],
      title: 'Select Directory',
    });
    return result.filePaths[0];
  });
  
  ipcMain.handle('dialog:openFiles', async (event, options) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile', 'multiSelections'],
      filters: options?.filters || [],
      title: options?.title || 'Select Files',
    });
    return result.filePaths;
  });
  
  ipcMain.handle('dialog:saveFile', async (event, options) => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      filters: options?.filters || [],
      title: options?.title || 'Save File',
      defaultPath: options?.defaultPath,
    });
    return result.filePath;
  });
  
  ipcMain.handle('shell:openExternal', async (event, url) => {
    await shell.openExternal(url);
  });
  
  ipcMain.handle('shell:openPath', async (event, path) => {
    await shell.openPath(path);
  });
  
  // Backend API proxy - expose all nocaiAPI methods
  ipcMain.handle('nocai:auth:getStatus', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/status`);
    return response.json();
  });

  ipcMain.handle('nocai:auth:login', async (event, credentials) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials),
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json() as { token: string };
    sessionToken = result.token;
    return result;
  });
  
  ipcMain.handle('nocai:auth:logout', async () => {
    if (!sessionToken) return { success: true };
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    const result = await response.json();
    sessionToken = null;
    return result;
  });
  
  ipcMain.handle('nocai:auth:getSession', async () => {
    if (!sessionToken) return null;
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/session`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:auth:changePassword', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/auth/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Chat
  ipcMain.handle('nocai:chat:getConversations', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:createConversation', async (event, title) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ title }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:deleteConversation', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:renameConversation', async (event, { id, title }) => {
    const payload = { id, title } satisfies RenamePayload;
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${payload.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ title: payload.title }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:chat:updateConversation', async (event, { id, updates }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:chat:getMessages', async (event, { conversationId, limit, offset }: ChatLoadPayload) => {
    const params = new URLSearchParams({ limit: String(limit || 50), offset: String(offset || 0) });
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/conversations/${conversationId}/messages?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:chat:sendMessage', async (event, request: ChatSendPayload) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ ...request, stream: false }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:chat:stopGeneration', async (event, generationId) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/chat/stop/${encodeURIComponent(generationId)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Models
  ipcMain.handle('nocai:models:listModels', async (event, role) => {
    const params = role ? `?role=${role}` : '';
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:scanDirectory', async (event, path) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:importModel', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:activateModel', async (event, { id, role }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ role }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:deactivateModel', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}/deactivate`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:deleteModel', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:getHardwareInfo', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/hardware`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:models:estimateModelRequirements', async (event, path) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/models/estimate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Knowledge
  ipcMain.handle('nocai:knowledge:listCollections', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:createCollection', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:deleteCollection', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:knowledge:selectDocuments', async () => {
    if (!mainWindow) return [];
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: 'Select documents',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Supported documents', extensions: ['txt', 'md', 'pdf', 'docx', 'csv', 'html', 'htm'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (selection.canceled) return [];
    return selection.filePaths.flatMap((path) => {
      try {
        const stats = statSync(path);
        return stats.isFile() ? [{ path, name: basename(path), size: stats.size }] : [];
      } catch {
        return [];
      }
    });
  });
  
  ipcMain.handle('nocai:knowledge:uploadDocuments', async (event, { collectionId, filePaths }: KnowledgeUploadPayload) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${collectionId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ filePaths }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:listDocuments', async (event, collectionId) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/collections/${collectionId}/documents`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:deleteDocument', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/documents/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:reprocessDocument', async (event, { documentId: id }: ReprocessPayload) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/documents/${id}/reprocess`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:knowledge:search', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/knowledge/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // Admin
  ipcMain.handle('nocai:admin:listUsers', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:createUser', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:updateUser', async (event, { id, ...req }) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:deleteUser', async (event, id) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:listRoles', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/roles`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getAuditLog', async (event, filter) => {
    const params = new URLSearchParams(filter as Record<string, string>);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/audit?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getJobs', async (event, filter) => {
    const params = new URLSearchParams(filter as Record<string, string>);
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/jobs?${params}`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:getHealth', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/admin/health`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:admin:restartBackend', async () => {
    await restartBackendService();
    return { success: true };
  });
  
  // Settings
  ipcMain.handle('nocai:settings:get', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/settings`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:settings:update', async (event, req) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  // System
  ipcMain.handle('nocai:system:getHealth', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/health/ready`);
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });

  ipcMain.handle('nocai:system:getVersion', async () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC.SYSTEM_SHUTDOWN, async () => {
    await shutdown();
  });
  
  ipcMain.handle('nocai:system:getDataPaths', async () => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/data-paths`, {
      headers: { 'Authorization': `Bearer ${sessionToken}` },
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:createBackup', async (event, options) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify(options),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:restoreBackup', async (event, path) => {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/v1/system/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
      body: JSON.stringify({ path }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  });
  
  ipcMain.handle('nocai:system:restartBackend', async () => {
    await restartBackendService();
    return { success: true };
  });
  
  // Events (Main -> Renderer)
  // These are not handlers but events that main sends to renderer
}

// App lifecycle
app.on('ready', async () => {
  setupIpcHandlers();
  
  // Single instance lock
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  
  const startupPromise = startBackendUntilReady();
  backendStartupPromise = startupPromise;
  await createWindow();
  
  // Start backend
  try {
    mainWindow?.webContents.send('backend:status', { status: 'starting' });
    await startupPromise;
    mainWindow?.webContents.send('backend:status', { status: 'ready', port: backendPort });
    mainWindow?.webContents.send('app:ready', {
      version: app.getVersion(),
      backendPort,
    });
  } catch (error) {
    console.error('Backend startup failed', error);
    mainWindow?.webContents.send('backend:status', { 
      status: 'error', 
      error: error instanceof Error ? error.message : String(error),
      recoverable: true
    });
  }
});

app.on('before-quit', async (event) => {
  if (!isShuttingDown) {
    event.preventDefault();
    await shutdown();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await createWindow();
  }
});
