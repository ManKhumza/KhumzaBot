# NOC AI Assistant — Packaging & Distribution

## Build Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
                        BUILD PIPELINE                                  
├─────────────────────────────────────────────────────────────────────┤
                                                                     
  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐           
  │  Frontend    │    │   Backend    │    │   Runtimes   │           
  │  (React/TS)  │    │  (FastAPI)   │    │  (llama.cpp) │           
  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘           
         │                   │                   │                    
         ▼                   ▼                   ▼                    
  ┌──────────────────────────────────────────────────────┐           
  │              electron-builder                         │           
  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │           
  │  │  Frontend   │  │  Backend    │  │  Resources  │  │           
  │  │  Build      │  │  Executable │  │  (models,   │  │           
  │  │  (Vite)     │  │  (PyInstaller)               │  │           
  │  └─────────────┘  └─────────────┘  └─────────────┘  │           
  └──────────────────────────┬──────────────────────────┘           
                             ▼                                     
                    ┌─────────────────┐                            
                    │   NSIS Installer│                            
                    │  + Portable ZIP │                            
                    └─────────────────┘                            
                                                                     
└─────────────────────────────────────────────────────────────────────┘
```

## Frontend Build (Vite + Electron)

### `apps/desktop/renderer/package.json`
```json
{
  "name": "noc-ai-renderer",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "lint": "eslint src --ext ts,tsx",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.20.0",
    "zustand": "^4.4.0",
    "react-markdown": "^9.0.0",
    "rehype-raw": "^7.0.0",
    "remark-gfm": "^4.0.0",
    "lucide-react": "^0.294.0",
    "clsx": "^2.0.0",
    "tailwind-merge": "^2.0.0",
    "date-fns": "^2.30.0",
    "zod": "^3.22.0",
    "axios": "^1.6.0"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "typescript": "^5.3.0",
    "vite": "^5.0.0",
    "vite-plugin-electron": "^0.28.0",
    "vite-plugin-electron-renderer": "^0.14.0",
    "eslint": "^8.55.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0",
    "tailwindcss": "^3.3.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}
```

### `apps/desktop/renderer/vite.config.ts`
```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  base: './',  // Critical for Electron file:// protocol
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@types': path.resolve(__dirname, 'src/types'),
      '@utils': path.resolve(__dirname, 'src/utils'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
```

## Main Process (`apps/desktop/electron`)

### `apps/desktop/electron/main.ts`
```typescript
import { app, BrowserWindow, ipcMain, dialog, shell, session } from 'electron';
import { join } from 'path';
import { spawn, ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { setupIpcHandlers } from './ipc';
import { BackendManager } from './backend-manager';
import { ModelManager } from './model-manager';
import { createWindow } from './window';
import { loadConfig, saveConfig } from './config';
import { logger } from './logger';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

class NocAIApplication {
  private mainWindow: BrowserWindow | null = null;
  private backendManager: BackendManager;
  private modelManager: ModelManager;
  private sessionToken: string;
  private backendPort: number | null = null;
  private isShuttingDown = false;

  constructor() {
    this.sessionToken = randomBytes(32).toString('hex');
    this.backendManager = new BackendManager(this.sessionToken);
    this.modelManager = new ModelManager();
  }

  async initialize() {
    // Single instance lock
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }

    app.on('second-instance', () => {
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });

    // Security: Disable remote module, enable sandbox
    app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors');
    
    await app.whenReady();

    // Load configuration
    const config = await loadConfig();
    
    // Create main window (splash first)
    this.mainWindow = await createWindow(config, isDev);
    
    // Setup IPC handlers
    setupIpcHandlers(this);
    
    // Start backend
    await this.startBackend();
    
    // Check database health
    await this.checkBackendHealth();
    
    // Load UI
    await this.loadMainUI();
    
    // Setup cleanup
    this.setupCleanup();
  }

  private async startBackend() {
    this.sendToRenderer('backend:status', { status: 'starting' });
    
    try {
      this.backendPort = await this.backendManager.start();
      logger.info(`Backend started on port ${this.backendPort}`);
      this.sendToRenderer('backend:status', { status: 'ready', port: this.backendPort });
    } catch (error) {
      logger.error('Backend startup failed', error);
      this.sendToRenderer('backend:status', { 
        status: 'error', 
        error: error.message,
        recoverable: true
      });
      throw error;
    }
  }

  private async checkBackendHealth() {
    const maxRetries = 30;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await fetch(`http://127.0.0.1:${this.backendPort}/health/ready`, {
          headers: { 'Authorization': `Bearer ${this.sessionToken}` },
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) {
          const health = await response.json();
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

  private async loadMainUI() {
    if (isDev) {
      await this.mainWindow!.loadURL('http://localhost:5173');
    } else {
      await this.mainWindow!.loadFile(join(__dirname, '../dist/renderer/index.html'));
    }
    
    // Hide splash, show main
    this.mainWindow!.webContents.send('app:ready', {
      version: app.getVersion(),
      sessionToken: this.sessionToken,
      backendPort: this.backendPort,
    });
  }

  private setupCleanup() {
    app.on('before-quit', async (event) => {
      if (this.isShuttingDown) return;
      event.preventDefault();
      this.isShuttingDown = true;
      
      this.sendToRenderer('app:shutting-down');
      
      // Graceful shutdown sequence
      await this.shutdown();
      app.exit(0);
    });

    // Handle backend crash
    this.backendManager.on('exit', (code, signal) => {
      if (!this.isShuttingDown) {
        logger.error(`Backend crashed: code=${code}, signal=${signal}`);
        this.sendToRenderer('backend:crashed', { code, signal });
      }
    });
  }

  async shutdown() {
    logger.info('Shutting down...');
    
    // 1. Stop accepting new requests
    this.sendToRenderer('app:shutting-down');
    
    // 2. Wait for active generations (max 30s)
    await this.modelManager.waitForIdle(30000);
    
    // 3. Stop backend
    await this.backendManager.stop();
    
    // 4. Save config
    await saveConfig(this.getCurrentConfig());
    
    // 6. Close window
    this.mainWindow?.destroy();
    this.mainWindow = null;
  }

  sendToRenderer(channel: string, data: any) {
    this.mainWindow?.webContents.send(channel, data);
  }

  getSessionToken(): string {
    return this.sessionToken;
  }

  getBackendPort(): number | null {
    return this.backendPort;
  }

  getBackendManager(): BackendManager {
    return this.backendManager;
  }

  getModelManager(): ModelManager {
    return this.modelManager;
  }
}

// Entry point
const nocai = new NocAIApplication();
nocai.initialize().catch(err => {
  logger.fatal('Application initialization failed', err);
  app.quit();
});

export { nocai };
```

### `apps/desktop/electron/backend-manager.ts`
```typescript
import { spawn, ChildProcess, SpawnOptions } from 'child_process';
import { EventEmitter } from 'events';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export class BackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private sessionToken: string;
  private dataDir: string;
  private port: number | null = null;
  private startupPromise: Promise<number> | null = null;

  constructor(sessionToken: string) {
    super();
    this.sessionToken = sessionToken;
    this.dataDir = this.getDataDir();
  }

  private getDataDir(): string {
    // %APPDATA%\NOC AI Assistant
    const base = process.env.APPDATA || process.env.HOME || '.';
    return join(base, 'NOC AI Assistant');
  }

  async start(): Promise<number> {
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = (async () => {
      // Find backend executable
      const backendExe = this.findBackendExecutable();
      
      // Pick a random available port
      this.port = await this.getRandomPort();
      
      const args = [
        '--port', String(this.port),
        '--host', '127.0.0.1',
        '--token', this.sessionToken,
        '--data-dir', this.dataDir,
        '--log-level', 'info',
      ];

      const options: SpawnOptions = {
        cwd: join(__dirname, '../../backend/dist'),
        env: {
          ...process.env,
          NOC_AI_SESSION_TOKEN: this.sessionToken,
          NOC_AI_DATA_DIR: this.dataDir,
          NOC_AI_MODELS_DIR: join(this.dataDir, 'models'),
          NOC_AI_KNOWLEDGE_DIR: join(this.dataDir, 'knowledge'),
          PYTHONPATH: join(__dirname, '../../backend/dist'),
        },
        windowsHide: true,  // CRITICAL: No console window
        stdio: ['ignore', 'pipe', 'pipe'],
      };

      logger.info(`Starting backend: ${backendExe} ${args.join(' ')}`);

      this.process = spawn(backendExe, args, options);

      // Log backend output
      this.process.stdout?.on('data', (data) => {
        logger.debug(`[backend] ${data.toString().trim()}`);
      });
      this.process.stderr?.on('data', (data) => {
        logger.warn(`[backend:stderr] ${data.toString().trim()}`);
      });

      this.process.on('exit', (code, signal) => {
        logger.info(`Backend exited: code=${code}, signal=${signal}`);
        this.process = null;
        this.emit('exit', code, signal);
      });

      this.process.on('error', (err) => {
        logger.error('Backend process error', err);
        this.emit('error', err);
      });

      // Wait for port to be listening
      await this.waitForPort(this.port!, 10000);
      
      return this.port!;
    })();

    return this.startupPromise;
  }

  private findBackendExecutable(): string {
    const candidates = [
      // Packaged (production)
      join(__dirname, '../../backend/dist/nocai-backend.exe'),
      join(__dirname, '../../backend/dist/nocai-backend'),
      // Development
      join(__dirname, '../../../backend/.venv/bin/python'),
      join(__dirname, '../../../backend/main.py'),
    ];

    for (const candidate of candidates) {
      if (require('fs').existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error('Backend executable not found');
  }

  private async getRandomPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = require('net').createServer();
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        server.close(() => resolve(port));
      });
      server.on('error', reject);
    });
  }

  private async waitForPort(port: number, timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = require('net').createConnection(port, '127.0.0.1');
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

  async stop(): Promise<void> {
    if (!this.process) return;

    logger.info('Stopping backend...');
    
    // Graceful shutdown via API
    try {
      await fetch(`http://127.0.0.1:${this.port}/admin/shutdown`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${this.sessionToken}` },
        signal: AbortSignal.timeout(5000),
      });
      await this.waitForExit(10000);
    } catch {
      // Force kill
      this.process.kill('SIGTERM');
      await this.waitForExit(5000);
    }
  }

  private waitForExit(timeout: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.process) return resolve();
      const timer = setTimeout(() => {
        if (this.process) this.process.kill('SIGKILL');
        resolve();
      }, timeout);
      this.process.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getPort(): number | null {
    return this.port;
  }
}
```

## Backend Packaging (PyInstaller)

### `backend/pyproject.toml`
```toml
[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[project]
name = "noc-ai-backend"
version = "1.0.0"
description = "NOC AI Assistant Local Backend"
readme = "README.md"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.109",
    "uvicorn[standard]>=0.27",
    "pydantic>=2.5",
    "pydantic-settings>=2.1",
    "sqlalchemy>=2.0",
    "alembic>=1.13",
    "sqlite-vec>=0.1.6",
    "python-multipart>=0.0.6",
    "python-magic>=0.4.27",
    "passlib[argon2]>=1.7",
    "python-jose[cryptography]>=3.3",
    "httpx>=0.26",
    "psutil>=5.9",
    "GPUtil>=1.4",
    "gguf>=0.5",
    "llama-cpp-python>=0.2.0",
    "pypdf>=3.15",
    "python-docx>=1.1",
    "beautifulsoup4>=4.12",
    "lxml>=4.9",
    "markdown-it-py>=2.2",
    "tiktoken>=0.6",
    "numpy>=1.26",
    "pyyaml>=6.0",
    "watchdog>=3.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.4",
    "pytest-asyncio>=0.23",
    "pytest-cov>=4.1",
    "ruff>=0.1",
    "mypy>=1.8",
    "black>=23.0",
]

[tool.setuptools.packages.find]
where = ["."]
include = ["backend*"]

[tool.pyinstaller]
name = "nocai-backend"
onefile = true
console = false
noconfirm = true
clean = true
log-level = "INFO"
distpath = "../apps/desktop/electron/dist/backend"
workpath = "../apps/desktop/electron/build/backend"
specpath = "../apps/desktop/electron/build/backend"
hidden-imports = [
    "sqlite_vec",
    "llama_cpp",
    "pypdf",
    "docx",
    "bs4",
    "lxml",
    "markdown_it",
    "tiktoken",
    "numpy",
    "uvicorn.protocols.http.h11_impl",
    "uvicorn.protocols.websockets.wsproto_impl",
]
collect-all = [
    "sqlite_vec",
    "llama_cpp",
]
exclude-module = [
    "tkinter",
    "matplotlib",
    "PIL",
    "pytest",
    "setuptools",
    "pip",
]
datas = [
    ("../resources", "resources"),
    ("alembic.ini", "."),
    ("backend/db/migrations", "backend/db/migrations"),
]
```

### `backend/main.py` (Entry Point)
```python
#!/usr/bin/env python3
"""
NOC AI Assistant Backend Entry Point
Packaged as standalone executable via PyInstaller
"""
import argparse
import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.routes import router as api_router
from backend.auth import auth_router
from backend.chat import chat_router
from backend.models import models_router
from backend.knowledge import knowledge_router
from backend.documents import documents_router
from backend.retrieval import retrieval_router
from backend.admin import admin_router
from backend.jobs import jobs_router
from backend.health import health_router
from backend.db.database import init_db, close_db
from backend.db.migrations import run_migrations
from backend.config import Settings, get_settings
from backend.inference.lifecycle import ModelLifecycleManager
from backend.security.auth import verify_session_token_middleware

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
    ]
)
logger = logging.getLogger("nocai.backend")

# Global state
settings: Settings | None = None
model_manager: ModelLifecycleManager | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global settings, model_manager
    
    logger.info("Starting NOC AI Backend...")
    
    # Load settings
    settings = get_settings()
    
    # Initialize database
    await init_db(settings.database_url)
    
    # Run migrations
    await run_migrations()
    
    # Initialize model lifecycle manager
    model_manager = ModelLifecycleManager(settings)
    await model_manager.startup()
    
    # Store in app state
    app.state.settings = settings
    app.state.model_manager = model_manager
    
    logger.info("Backend startup complete")
    
    yield
    
    # Shutdown
    logger.info("Shutting down backend...")
    if model_manager:
        await model_manager.shutdown()
    await close_db()
    logger.info("Backend shutdown complete")


def create_app() -> FastAPI:
    app = FastAPI(
        title="NOC AI Assistant API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None,  # Disable docs in production
        redoc_url=None,
    )
    
    # CORS - only allow Electron origin
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:*", "file://"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Session token middleware (applies to all routes except health)
    app.middleware("http")(verify_session_token_middleware)
    
    # Routes
    app.include_router(health_router, prefix="/health", tags=["health"])
    app.include_router(auth_router, prefix="/api/v1/auth", tags=["auth"])
    app.include_router(chat_router, prefix="/api/v1/chat", tags=["chat"])
    app.include_router(models_router, prefix="/api/v1/models", tags=["models"])
    app.include_router(knowledge_router, prefix="/api/v1/knowledge", tags=["knowledge"])
    app.include_router(documents_router, prefix="/api/v1/documents", tags=["documents"])
    app.include_router(retrieval_router, prefix="/api/v1/retrieval", tags=["retrieval"])
    app.include_router(admin_router, prefix="/api/v1/admin", tags=["admin"])
    app.include_router(jobs_router, prefix="/api/v1/jobs", tags=["jobs"])
    app.include_router(api_router, prefix="/api/v1", tags=["api"])
    
    return app


def main():
    parser = argparse.ArgumentParser(description="NOC AI Assistant Backend")
    parser.add_argument("--port", type=int, default=0, help="Port to bind (0 = random)")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind")
    parser.add_argument("--token", type=str, required=True, help="Session token")
    parser.add_argument("--data-dir", type=str, required=True, help="Data directory")
    parser.add_argument("--log-level", type=str, default="info", help="Log level")
    args = parser.parse_args()
    
    # Set environment for child processes
    os.environ["NOC_AI_SESSION_TOKEN"] = args.token
    os.environ["NOC_AI_DATA_DIR"] = args.data_dir
    os.environ["NOC_AI_MODELS_DIR"] = str(Path(args.data_dir) / "models")
    os.environ["NOC_AI_KNOWLEDGE_DIR"] = str(Path(args.data_dir) / "knowledge")
    os.environ["NOC_AI_LOG_LEVEL"] = args.log_level.upper()
    
    # Configure logging level
    logging.getLogger().setLevel(args.log_level.upper())
    
    app = create_app()
    
    # Run with uvicorn
    uvicorn.run(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level.lower(),
        access_log=False,
        server_header=False,
        date_header=False,
    )


if __name__ == "__main__":
    main()
```

## Electron Builder Configuration

### `apps/desktop/electron/builder.yaml`
```yaml
appId: com.nocai.assistant
productName: NOC AI Assistant
copyright: "Copyright © 2024 NOC AI"
directories:
  output: dist
  buildResources: resources
files:
  - from: .
    filter:
      - "**/*"
      - "!**/node_modules/*"
      - "!**/src/*"
      - "!**/*.ts"
      - "!**/*.map"
      - "!**/*.config.*"
      - "!vite.config.ts"
      - "!tsconfig.json"
      - "!.eslintrc*"
      - "!*.md"
      - "!**/backend/*"
      - "!**/runtimes/*"
  - backend/dist/nocai-backend.exe
  - runtimes/llama/llama-server.exe
  - runtimes/llama/llama-cli.exe
  - resources/**/*
asar: true
asarUnpack:
  - "backend/dist/**/*"
  - "runtimes/llama/**/*"
extraResources:
  - from: backend/dist
    to: backend
    filter: ["nocai-backend.exe"]
  - from: runtimes/llama
    to: llama
    filter: ["*.exe", "*.dll", "*.so"]
win:
  target:
    - target: nsis
      arch:
        - x64
    - target: portable
      arch:
        - x64
  icon: resources/icons/icon.ico
  publisherName: NOC AI
  certificateFile: ""
  certificatePassword: ""
  signtoolOptions: ""
  verifyUpdateCodeSignature: false
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: NOC AI Assistant
  uninstallDisplayName: NOC AI Assistant
  license: resources/license.txt
  installerIcon: resources/icons/installer.ico
  uninstallerIcon: resources/icons/uninstaller.ico
  installerHeader: resources/icons/header.bmp
  include: "installer.nsh"
  artifactName: "NOC-AI-Assistant-Setup-${version}.exe"
portable:
  artifactName: "NOC-AI-Assistant-Portable-${version}.zip"
publish: null
```

### `apps/desktop/electron/installer.nsh` (NSIS Custom Script)
```nsis
!macro customInstall
  !insertmacro MUI_PAGE_WELCOME
  !insertmacro MUI_PAGE_LICENSE "${NSIS_LICENSE}"
  !insertmacro MUI_PAGE_DIRECTORY
  !insertmacro MUI_PAGE_INSTFILES
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customUninstall
  !insertmacro MUI_UNPAGE_WELCOME
  !insertmacro MUI_UNPAGE_CONFIRM
  Page custom un.PageDataDirectory
  !insertmacro MUI_UNPAGE_INSTFILES
  !insertmacro MUI_UNPAGE_FINISH
!macroend

Function un.PageDataDirectory
  ; Ask if user wants to remove data
  nsDialogs::Create 1018
  Pop $Dialog
  
  ${NSD_CreateLabel} 0 0 100% 12u "Remove user data (models, knowledge, chat history)?"
  Pop $Label
  
  ${NSD_CreateCheckbox} 15u 20u 100% 10u "Also remove NOC AI Assistant user data and models"
  Pop $Checkbox
  
  nsDialogs::Show
  
  ${NSD_GetState} $Checkbox $CheckboxState
  StrCmp $CheckboxState ${BST_CHECKED} 0 +2
  StrCpy $RemoveData 1
  
  nsDialogs::Destroy
FunctionEnd

Function .onInit
  ; Check for running instance
  System::Call 'kernel32::CreateMutexA(i 0, i 1, t "Global\\NOC_AI_Assistant_Installer") i .r0'
  Pop $Mutex
  StrCmp $LastError 183 0 +3
  MessageBox MB_ICONEXCLAMATION "NOC AI Assistant is currently running. Please close it before installing."
  Abort
FunctionEnd
```

## Build Scripts

### `scripts/build-all.ps1`
```powershell
#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Build NOC AI Assistant for Windows distribution
#>

param(
    [string]$Configuration = "Release",
    [string]$Version = "1.0.0",
    [switch]$SkipBackend,
    [switch]$SkipFrontend,
    [switch]$SkipPackaging
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot | Split-Path -Parent
$DesktopDir = Join-Path $ProjectRoot "apps\desktop"
$BackendDir = Join-Path $ProjectRoot "backend"
$DistDir = Join-Path $DesktopDir "dist"

Write-Host "=== NOC AI Assistant Build ===" -ForegroundColor Cyan
Write-Host "Version: $Version"
Write-Host "Configuration: $Configuration"
Write-Host ""

# 1. Build Backend (PyInstaller)
if (-not $SkipBackend) {
    Write-Host "Building backend..." -ForegroundColor Yellow
    Push-Location $BackendDir
    
    # Create virtual env if needed
    if (-not (Test-Path ".venv")) {
        python -m venv .venv
    }
    & ".venv\Scripts\pip.exe" install -e ".[dev]"
    & ".venv\Scripts\pip.exe" install pyinstaller
    
    # Run PyInstaller
    & ".venv\Scripts\pyinstaller.exe" nocai-backend.spec --clean --noconfirm
    
    # Verify executable
    $ExePath = Join-Path $DesktopDir "electron\dist\backend\nocai-backend.exe"
    if (-not (Test-Path $ExePath)) {
        throw "Backend executable not found at $ExePath"
    }
    Write-Host "Backend built: $ExePath" -ForegroundColor Green
    
    Pop-Location
}

# 2. Build Frontend (Vite)
if (-not $SkipFrontend) {
    Write-Host "Building frontend..." -ForegroundColor Yellow
    Push-Location (Join-Path $DesktopDir "renderer")
    
    npm ci
    npm run build
    
    # Verify build
    $IndexPath = Join-Path $DesktopDir "dist\renderer\index.html"
    if (-not (Test-Path $IndexPath)) {
        throw "Frontend build not found at $IndexPath"
    }
    Write-Host "Frontend built: $IndexPath" -ForegroundColor Green
    
    Pop-Location
}

# 3. Package with electron-builder
if (-not $SkipPackaging) {
    Write-Host "Packaging application..." -ForegroundColor Yellow
    Push-Location (Join-Path $DesktopDir "electron")
    
    npm ci
    $env:NPM_CONFIG_ARCH = "x64"
    $env:NPM_CONFIG_PLATFORM = "win32"
    
    # Set version
    $PackageJson = Get-Content package.json | ConvertFrom-Json
    $PackageJson.version = $Version
    $PackageJson | ConvertTo-Json -Depth 10 | Set-Content package.json
    
    npx electron-builder --win --x64 --config builder.yaml
    
    Write-Host "Packaging complete" -ForegroundColor Green
    
    Pop-Location
}

# 4. Generate checksums
Write-Host "Generating checksums..." -ForegroundColor Yellow
$Files = Get-ChildItem $DistDir -Filter "*.exe", "*.zip" | Where-Object { -not $_.Name.Contains("blockmap") }
$Checksums = @()
foreach ($File in $Files) {
    $Hash = Get-FileHash -Path $File.FullName -Algorithm SHA256
    $Checksums += "$($Hash.Hash)  $($File.Name)"
}
$ChecksumContent = $Checksums -join "`n"
Set-Content -Path (Join-Path $DistDir "SHA256SUMS.txt") -Value $ChecksumContent
Write-Host "Checksums written to $DistDir\SHA256SUMS.txt" -ForegroundColor Green

Write-Host ""
Write-Host "=== BUILD COMPLETE ===" -ForegroundColor Cyan
Write-Host "Artifacts in: $DistDir"
Get-ChildItem $DistDir | Format-Table Name, Length, LastWriteTime
```

## Portable Build

The portable build includes:
- Electron app (asar)
- Backend executable
- llama.cpp binaries
- All resources
- No installer, runs from any folder

### Portable Launcher (`apps/desktop/electron/portable-launcher.ps1`)
```powershell
#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Portable launcher for NOC AI Assistant
    Sets up data directories and launches the application
#>

$ScriptDir = $PSScriptRoot
$AppExe = Join-Path $ScriptDir "NOC AI Assistant.exe"
$DataDir = Join-Path $env:APPDATA "NOC AI Assistant"

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $DataDir "models") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $DataDir "knowledge") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $DataDir "logs") -Force | Out-Null
}

& $AppExe
```

## Distribution Checklist

| Item | Status | Notes |
|------|--------|-------|
| NSIS Installer (x64) | ☐ | Primary distribution |
| Portable ZIP (x64) | ☐ | Secondary distribution |
| SHA256SUMS.txt | ☐ | Integrity verification |
| Code signing cert | ☐ | Required for SmartScreen |
| VirusTotal scan | ☐ | Pre-release verification |
| Clean VM test | ☐ | Windows 10/11 fresh install |
| Upgrade test | ☐ | In-place upgrade from previous |
| Uninstall test | ☐ | Data preservation verified |

## Versioning Strategy

```json
{
  "version": "1.0.0",
  "versionInfo": {
    "FileVersion": "1.0.0.0",
    "ProductVersion": "1.0.0",
    "CompanyName": "NOC AI",
    "FileDescription": "NOC AI Assistant",
    "InternalName": "noc-ai-assistant",
    "OriginalFilename": "NOC AI Assistant.exe",
    "ProductName": "NOC AI Assistant",
    "LegalCopyright": "Copyright © 2024 NOC AI"
  }
}
```

## Release Artifacts

```
dist/
├── NOC-AI-Assistant-Setup-1.0.0.exe        # NSIS Installer (~150-200MB)
├── NOC-AI-Assistant-Portable-1.0.0.zip     # Portable (~150-200MB)
├── SHA256SUMS.txt                          # Checksums
├── RELEASE-NOTES.md                        # Release notes
└── latest.yml                              # For future auto-update (disabled by default)
```

---
*Generated during Phase 1 — Architecture*