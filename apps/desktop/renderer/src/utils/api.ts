import type {
  User,
  Session,
  Model,
  Collection,
  Document,
  Conversation,
  ConversationUpdate,
  Message,
  Citation,
  SearchResult,
  ChatRequest,
  ChatChunk,
  JobProgress,
  HealthStatus,
  Settings,
  HardwareInfo,
  ResourceEstimate,
  AuditEntry,
  Role,
  BackupOptions,
  BackupResult,
  RestoreResult,
  SelectedDocumentFile,
} from '@/types';

// IPC API types exposed by preload
declare global {
  interface Window {
    nocai: {
      // Auth
      auth: {
        getStatus: () => Promise<{ needsSetup: boolean }>;
        login: (credentials: { username: string; password: string }) => Promise<{ user: User; token: string; expiresAt: string }>;
        logout: () => Promise<void>;
        getSession: () => Promise<Session | null>;
        changePassword: (req: { currentPassword: string; newPassword: string }) => Promise<void>;
      };
      // Chat
      chat: {
        getConversations: () => Promise<Conversation[]>;
        createConversation: (title?: string) => Promise<Conversation>;
        deleteConversation: (id: string) => Promise<void>;
        renameConversation: (id: string, title: string) => Promise<void>;
        updateConversation: (id: string, updates: ConversationUpdate) => Promise<Conversation>;
        getMessages: (conversationId: string, limit?: number, offset?: number) => Promise<Message[]>;
        sendMessage: (request: ChatRequest) => Promise<{
          id: string;
          content: string;
          finishReason?: string | null;
          citations?: Citation[];
          usage?: ChatChunk['usage'];
        }>;
        stopGeneration: (generationId: string) => Promise<void>;
      };
      // Models
      models: {
        listModels: (role?: 'chat' | 'embedding' | 'reranker') => Promise<Model[]>;
        scanDirectory: (path: string) => Promise<ModelScanResult>;
        importModel: (req: ImportModelRequest) => Promise<Model>;
        activateModel: (id: string, role: 'chat' | 'embedding') => Promise<void>;
        deactivateModel: (id: string) => Promise<void>;
        deleteModel: (id: string) => Promise<void>;
        getHardwareInfo: () => Promise<HardwareInfo>;
        estimateModelRequirements: (path: string) => Promise<ResourceEstimate>;
      };
      // Knowledge
      knowledge: {
        listCollections: () => Promise<Collection[]>;
        createCollection: (req: CreateCollectionRequest) => Promise<Collection>;
        deleteCollection: (id: string) => Promise<void>;
        selectDocuments: () => Promise<SelectedDocumentFile[]>;
        uploadDocuments: (collectionId: string, filePaths: string[]) => Promise<Document[]>;
        listDocuments: (collectionId: string) => Promise<Document[]>;
        deleteDocument: (id: string) => Promise<void>;
        reprocessDocument: (id: string) => Promise<void>;
        search: (req: SearchRequest) => Promise<SearchResult[]>;
      };
      // Admin
      admin: {
        listUsers: () => Promise<User[]>;
        createUser: (req: CreateUserRequest) => Promise<User>;
        updateUser: (id: string, req: UpdateUserRequest) => Promise<User>;
        deleteUser: (id: string) => Promise<void>;
        listRoles: () => Promise<Role[]>;
        getAuditLog: (filter: AuditFilter) => Promise<AuditEntry[]>;
        getJobs: (filter: JobFilter) => Promise<JobProgress[]>;
        getHealth: () => Promise<HealthStatus>;
        restartBackend: () => Promise<{ success: boolean }>;
      };
      // Settings
      settings: {
        get: () => Promise<Settings>;
        update: (partial: Partial<Settings>) => Promise<Settings>;
      };
      // System
      system: {
        getHealth: () => Promise<{ status: string; service: string }>;
        getVersion: () => Promise<string>;
        getDataPaths: () => Promise<DataPaths>;
        createBackup: (options: BackupOptions) => Promise<BackupResult>;
        restoreBackup: (path: string) => Promise<RestoreResult>;
        restartBackend: () => Promise<{ success: boolean }>;
      };
      // Backend direct access
      backend: {
        request: (options: { method: string; path: string; body?: any }) => Promise<any>;
        restart: () => Promise<{ success: boolean }>;
      };
      // Dialogs
      dialog: {
        openDirectory: () => Promise<string | undefined>;
        openFiles: (options?: { filters?: any[]; title?: string }) => Promise<string[]>;
        saveFile: (options?: { filters?: any[]; title?: string; defaultPath?: string }) => Promise<string | undefined>;
      };
      // Shell
      shell: {
        openExternal: (url: string) => Promise<void>;
        openPath: (path: string) => Promise<void>;
      };
      // Events (Main -> Renderer)
      onBackendStatusChange: (callback: (status: BackendStatusEvent) => void) => () => void;
      onAppReady: (callback: (data: AppReadyEvent) => void) => () => void;
      onAppShuttingDown: (callback: () => void) => () => void;
      onBackendCrashed: (callback: (data: BackendCrashedEvent) => void) => () => void;
      onBackendError: (callback: (data: BackendErrorEvent) => void) => () => void;
    };
  }
}

// Additional types for IPC
interface ModelScanResult {
  models: Array<{
    filepath: string;
    filename: string;
    sizeBytes: number;
    isValidGguf: boolean;
    metadata: Record<string, any> | null;
    error: string | null;
    suggestedRole: 'chat' | 'embedding' | null;
    suggestedName: string;
  }>;
}

interface ImportModelRequest {
  sourcePath: string;
  role: 'chat' | 'embedding';
  name?: string;
  copy?: boolean;
}

interface CreateCollectionRequest {
  name: string;
  description?: string;
  embeddingModelId: string;
  embeddingConfig: {
    chunkSize: number;
    chunkOverlap: number;
    topK: number;
    hybridAlpha: number;
    enableReranking: boolean;
  };
  chunkingConfig: {
    chunkSize: number;
    chunkOverlap: number;
    minChunkSize: number;
    respectBoundaries: boolean;
  };
}

interface SearchRequest {
  query: string;
  collectionIds?: string[];
  topK?: number;
  enableHybrid?: boolean;
  hybridAlpha?: number;
  enableReranking?: boolean;
}

interface CreateUserRequest {
  username: string;
  password: string;
  displayName?: string;
  email?: string;
  roles: string[];
}

interface UpdateUserRequest {
  displayName?: string;
  email?: string;
  roles?: string[];
  isActive?: boolean;
}

interface AuditFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

interface JobFilter {
  status?: string;
  priority?: number;
  limit?: number;
  offset?: number;
}

interface DataPaths {
  appData: string;
  models: string;
  knowledge: string;
  logs: string;
  cache: string;
}

interface BackendStatusEvent {
  status: 'starting' | 'ready' | 'error' | 'stopped';
  port?: number;
  error?: string;
}

interface AppReadyEvent {
  version: string;
  backendPort: number;
}

interface BackendCrashedEvent {
  code: number | null;
  signal: string | null;
}

interface BackendErrorEvent {
  message: string;
}

// API wrapper with error handling
class NocAIAPI {
  private ready = false;
  private initPromise: Promise<void> | null = null;

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (!this.initPromise) {
      this.initPromise = this.initialize();
    }
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    // Wait for preload to be ready
    await new Promise<void>((resolve) => {
      if (window.nocai) {
        resolve();
      } else {
        window.addEventListener('nocai:ready', () => resolve(), { once: true });
      }
    });
    this.ready = true;
  }

  // Auth
  auth = {
    getStatus: async () => {
      await this.ensureReady();
      return window.nocai.auth.getStatus();
    },
    login: async (credentials: { username: string; password: string }) => {
      await this.ensureReady();
      return window.nocai.auth.login(credentials);
    },
    logout: async () => {
      await this.ensureReady();
      return window.nocai.auth.logout();
    },
    getSession: async () => {
      await this.ensureReady();
      return window.nocai.auth.getSession();
    },
    changePassword: async (req: { currentPassword: string; newPassword: string }) => {
      await this.ensureReady();
      return window.nocai.auth.changePassword(req);
    },
  };

  // Chat
  chat = {
    getConversations: async () => {
      await this.ensureReady();
      return window.nocai.chat.getConversations();
    },
    createConversation: async (title?: string) => {
      await this.ensureReady();
      return window.nocai.chat.createConversation(title);
    },
    deleteConversation: async (id: string) => {
      await this.ensureReady();
      return window.nocai.chat.deleteConversation(id);
    },
    renameConversation: async (id: string, title: string) => {
      await this.ensureReady();
      return window.nocai.chat.renameConversation(id, title);
    },
    updateConversation: async (id: string, updates: ConversationUpdate) => {
      await this.ensureReady();
      return window.nocai.chat.updateConversation(id, updates);
    },
    getMessages: async (conversationId: string, limit?: number, offset?: number) => {
      await this.ensureReady();
      return window.nocai.chat.getMessages(conversationId, limit, offset);
    },
    sendMessage: async (req: ChatRequest): Promise<AsyncGenerator<ChatChunk, void, unknown>> => {
      await this.ensureReady();
      const data = await window.nocai.chat.sendMessage({ ...req, stream: false });
      return (async function* () {
        yield {
          id: data.id,
          delta: data.content,
          finishReason: data.finishReason || 'stop',
          citations: data.citations || [],
          usage: data.usage || undefined,
        };
      })();
    },
    stopGeneration: async (requestId: string) => {
      await this.ensureReady();
      return window.nocai.chat.stopGeneration(requestId);
    },
  };

    // Models
    models = {
      listModels: async (role?: 'chat' | 'embedding' | 'reranker') => {
        await this.ensureReady();
        return window.nocai.models.listModels(role);
      },
      scanDirectory: async (path: string) => {
        await this.ensureReady();
        return window.nocai.models.scanDirectory(path);
      },
      importModel: async (req: ImportModelRequest) => {
        await this.ensureReady();
        return window.nocai.models.importModel(req);
      },
      activateModel: async (id: string, role: 'chat' | 'embedding') => {
        await this.ensureReady();
        return window.nocai.models.activateModel(id, role);
      },
      deactivateModel: async (id: string) => {
        await this.ensureReady();
        return window.nocai.models.deactivateModel(id);
      },
      deleteModel: async (id: string) => {
        await this.ensureReady();
        return window.nocai.models.deleteModel(id);
      },
      getHardwareInfo: async () => {
        await this.ensureReady();
        return window.nocai.models.getHardwareInfo();
      },
      estimateModelRequirements: async (path: string) => {
        await this.ensureReady();
        return window.nocai.models.estimateModelRequirements(path);
      },
    };

    // Knowledge
    knowledge = {
      listCollections: async () => {
        await this.ensureReady();
        return window.nocai.knowledge.listCollections();
      },
      createCollection: async (req: CreateCollectionRequest) => {
        await this.ensureReady();
        return window.nocai.knowledge.createCollection(req);
      },
      deleteCollection: async (id: string) => {
        await this.ensureReady();
        return window.nocai.knowledge.deleteCollection(id);
      },
      selectDocuments: async () => {
        await this.ensureReady();
        return window.nocai.knowledge.selectDocuments();
      },
      uploadDocuments: async (collectionId: string, filePaths: string[]) => {
        await this.ensureReady();
        return window.nocai.knowledge.uploadDocuments(collectionId, filePaths);
      },
      listDocuments: async (collectionId: string) => {
        await this.ensureReady();
        return window.nocai.knowledge.listDocuments(collectionId);
      },
      deleteDocument: async (id: string) => {
        await this.ensureReady();
        return window.nocai.knowledge.deleteDocument(id);
      },
      reprocessDocument: async (id: string) => {
        await this.ensureReady();
        return window.nocai.knowledge.reprocessDocument(id);
      },
      search: async (req: SearchRequest) => {
        await this.ensureReady();
        return window.nocai.knowledge.search(req);
      },
    };

    // Admin
    admin = {
      listUsers: async () => {
        await this.ensureReady();
        return window.nocai.admin.listUsers();
      },
      createUser: async (req: CreateUserRequest) => {
        await this.ensureReady();
        return window.nocai.admin.createUser(req);
      },
      updateUser: async (id: string, req: UpdateUserRequest) => {
        await this.ensureReady();
        return window.nocai.admin.updateUser(id, req);
      },
      deleteUser: async (id: string) => {
        await this.ensureReady();
        return window.nocai.admin.deleteUser(id);
      },
      listRoles: async () => {
        await this.ensureReady();
        return window.nocai.admin.listRoles();
      },
      getAuditLog: async (filter: AuditFilter) => {
        await this.ensureReady();
        return window.nocai.admin.getAuditLog(filter);
      },
      getJobs: async (filter: JobFilter) => {
        await this.ensureReady();
        return window.nocai.admin.getJobs(filter);
      },
      getHealth: async () => {
        await this.ensureReady();
        return window.nocai.admin.getHealth();
      },
      restartBackend: async () => {
        await this.ensureReady();
        return window.nocai.admin.restartBackend();
      },
    };

    // Settings
    settings = {
      get: async () => {
        await this.ensureReady();
        return window.nocai.settings.get();
      },
      update: async (partial: Partial<Settings>) => {
        await this.ensureReady();
        return window.nocai.settings.update(partial);
      },
    };

    // System
    system = {
      getHealth: async () => {
        await this.ensureReady();
        return window.nocai.system.getHealth();
      },
      getVersion: async () => {
        await this.ensureReady();
        return window.nocai.system.getVersion();
      },
      getDataPaths: async () => {
        await this.ensureReady();
        return window.nocai.system.getDataPaths();
      },
      createBackup: async (options: BackupOptions) => {
        await this.ensureReady();
        return window.nocai.system.createBackup(options);
      },
      restoreBackup: async (path: string) => {
        await this.ensureReady();
        return window.nocai.system.restoreBackup(path);
      },
      restartBackend: async () => {
        await this.ensureReady();
        return window.nocai.system.restartBackend();
      },
    };

    // Backend direct access
    backend = {
      request: async (options: { method: string; path: string; body?: any }) => {
        await this.ensureReady();
        return window.nocai.backend.request(options);
      },
      restart: async () => {
        await this.ensureReady();
        return window.nocai.backend.restart();
      },
    };

    // Events
    onBackendStatusChange = (callback: (status: BackendStatusEvent) => void) => {
      this.ensureReady().then(() => {
        return window.nocai.onBackendStatusChange(callback);
      });
    };

    onAppReady = (callback: (data: AppReadyEvent) => void) => {
      this.ensureReady().then(() => {
        return window.nocai.onAppReady(callback);
      });
    };

    onAppShuttingDown = (callback: () => void) => {
      this.ensureReady().then(() => {
        return window.nocai.onAppShuttingDown(callback);
      });
    };

    onBackendCrashed = (callback: (data: BackendCrashedEvent) => void) => {
      this.ensureReady().then(() => {
        return window.nocai.onBackendCrashed(callback);
      });
    };

    onBackendError = (callback: (data: BackendErrorEvent) => void) => {
      this.ensureReady().then(() => {
        return window.nocai.onBackendError(callback);
      });
    };

  }

  export const nocaiAPI = new NocAIAPI();
