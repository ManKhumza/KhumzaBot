import type {
  ChatLoadPayload,
  ChatSendPayload,
  KnowledgeUploadPayload,
  ReprocessPayload,
} from '../shared/ipc-contract';

const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preloads cannot resolve arbitrary local CommonJS modules.
// Keep runtime channel values self-contained; the type-only contract import above
// is erased by TypeScript and therefore remains safe in the packaged preload.
const SYSTEM_SHUTDOWN_CHANNEL = 'nocai:system:shutdown';

// Expose the full nocai API that the renderer expects
contextBridge.exposeInMainWorld('nocai', {
  // Auth
  auth: {
    getStatus: () => ipcRenderer.invoke('nocai:auth:getStatus'),
    login: (credentials: { username: string; password: string }) => 
      ipcRenderer.invoke('nocai:auth:login', credentials),
    logout: () => ipcRenderer.invoke('nocai:auth:logout'),
    getSession: () => ipcRenderer.invoke('nocai:auth:getSession'),
    changePassword: (req: { currentPassword: string; newPassword: string }) => 
      ipcRenderer.invoke('nocai:auth:changePassword', req),
  },
  
  // Chat
  chat: {
    getConversations: () => ipcRenderer.invoke('nocai:chat:getConversations'),
    createConversation: (title?: string) => ipcRenderer.invoke('nocai:chat:createConversation', title),
    deleteConversation: (id: string) => ipcRenderer.invoke('nocai:chat:deleteConversation', id),
    renameConversation: (id: string, title: string) => ipcRenderer.invoke('nocai:chat:renameConversation', { id, title }),
    updateConversation: (id: string, updates: Record<string, unknown>) =>
      ipcRenderer.invoke('nocai:chat:updateConversation', { id, updates }),
    getMessages: (conversationId: string, limit?: number, offset?: number) => {
      const payload: ChatLoadPayload = { conversationId, limit, offset };
      return ipcRenderer.invoke('nocai:chat:getMessages', payload);
    },
    sendMessage: (request: ChatSendPayload) => ipcRenderer.invoke('nocai:chat:sendMessage', request),
    stopGeneration: (generationId: string) => ipcRenderer.invoke('nocai:chat:stopGeneration', generationId),
  },
  
  // Models
  models: {
    listModels: (role?: string) => ipcRenderer.invoke('nocai:models:listModels', role),
    scanDirectory: (path: string) => ipcRenderer.invoke('nocai:models:scanDirectory', path),
    importModel: (req: any) => ipcRenderer.invoke('nocai:models:importModel', req),
    activateModel: (id: string, role: string) => ipcRenderer.invoke('nocai:models:activateModel', { id, role }),
    deactivateModel: (id: string) => ipcRenderer.invoke('nocai:models:deactivateModel', id),
    deleteModel: (id: string) => ipcRenderer.invoke('nocai:models:deleteModel', id),
    getHardwareInfo: () => ipcRenderer.invoke('nocai:models:getHardwareInfo'),
    estimateModelRequirements: (path: string) => ipcRenderer.invoke('nocai:models:estimateModelRequirements', path),
  },
  
  // Knowledge
  knowledge: {
    listCollections: () => ipcRenderer.invoke('nocai:knowledge:listCollections'),
    createCollection: (req: any) => ipcRenderer.invoke('nocai:knowledge:createCollection', req),
    deleteCollection: (id: string) => ipcRenderer.invoke('nocai:knowledge:deleteCollection', id),
    selectDocuments: () => ipcRenderer.invoke('nocai:knowledge:selectDocuments'),
    uploadDocuments: (collectionId: string, filePaths: string[]) => {
      const payload: KnowledgeUploadPayload = { collectionId, filePaths };
      return ipcRenderer.invoke('nocai:knowledge:uploadDocuments', payload);
    },
    listDocuments: (collectionId: string) => ipcRenderer.invoke('nocai:knowledge:listDocuments', collectionId),
    deleteDocument: (id: string) => ipcRenderer.invoke('nocai:knowledge:deleteDocument', id),
    reprocessDocument: (id: string) => {
      const payload: ReprocessPayload = { documentId: id };
      return ipcRenderer.invoke('nocai:knowledge:reprocessDocument', payload);
    },
    search: (req: any) => ipcRenderer.invoke('nocai:knowledge:search', req),
  },
  
  // Admin
  admin: {
    listUsers: () => ipcRenderer.invoke('nocai:admin:listUsers'),
    createUser: (req: any) => ipcRenderer.invoke('nocai:admin:createUser', req),
    updateUser: (id: string, req: any) => ipcRenderer.invoke('nocai:admin:updateUser', { id, ...req }),
    deleteUser: (id: string) => ipcRenderer.invoke('nocai:admin:deleteUser', id),
    listRoles: () => ipcRenderer.invoke('nocai:admin:listRoles'),
    getAuditLog: (filter: any) => ipcRenderer.invoke('nocai:admin:getAuditLog', filter),
    getJobs: (filter: any) => ipcRenderer.invoke('nocai:admin:getJobs', filter),
    getHealth: () => ipcRenderer.invoke('nocai:admin:getHealth'),
    restartBackend: () => ipcRenderer.invoke('nocai:admin:restartBackend'),
  },
  
  // Settings
  settings: {
    get: () => ipcRenderer.invoke('nocai:settings:get'),
    update: (req: any) => ipcRenderer.invoke('nocai:settings:update', req),
  },
  
  // System
  system: {
    getHealth: () => ipcRenderer.invoke('nocai:system:getHealth'),
    getVersion: () => ipcRenderer.invoke('nocai:system:getVersion'),
    getDiagnostics: () => ipcRenderer.invoke('nocai:system:getDiagnostics'),
    exportDiagnostics: () => ipcRenderer.invoke('nocai:system:exportDiagnostics'),
    getDataPaths: () => ipcRenderer.invoke('nocai:system:getDataPaths'),
    createBackup: (options: any) => ipcRenderer.invoke('nocai:system:createBackup', options),
    restoreBackup: (path: string) => ipcRenderer.invoke('nocai:system:restoreBackup', path),
    restartBackend: () => ipcRenderer.invoke('nocai:system:restartBackend'),
    shutdown: () => ipcRenderer.invoke(SYSTEM_SHUTDOWN_CHANNEL),
  },
  
  // Events (Main -> Renderer)
  onBackendStatusChange: (callback: (status: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('backend:status', handler);
    return () => ipcRenderer.off('backend:status', handler);
  },
  
  onAppReady: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('app:ready', handler);
    return () => ipcRenderer.off('app:ready', handler);
  },
  
  onAppShuttingDown: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('app:shutting-down', handler);
    return () => ipcRenderer.off('app:shutting-down', handler);
  },
  
  onBackendCrashed: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('backend:crashed', handler);
    return () => ipcRenderer.off('backend:crashed', handler);
  },
  
  onBackendError: (callback: (data: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on('backend:error', handler);
    return () => ipcRenderer.off('backend:error', handler);
  },
  
  // Backend API direct access (for streaming chat)
  backend: {
    request: (options: { method: string; path: string; body?: any }) => 
      ipcRenderer.invoke('backend:request', options),
    restart: () => ipcRenderer.invoke('backend:restart'),
  },
  
  // Dialogs
  dialog: {
    openDirectory: () => ipcRenderer.invoke('dialog:openDirectory'),
    openFiles: (options?: any) => ipcRenderer.invoke('dialog:openFiles', options),
    saveFile: (options?: any) => ipcRenderer.invoke('dialog:saveFile', options),
  },
  
  // Shell
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
  },
});
