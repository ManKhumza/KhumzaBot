export interface User {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  roles: string[];
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Session {
  user: User;
  token: string;
  expiresAt: string;
}

export interface Model {
  id: string;
  name: string;
  filename: string;
  filepath: string;
  format: string;
  sizeBytes: number;
  architecture: string | null;
  quantization: string | null;
  parameterCount: string | null;
  contextLength: number;
  role: 'chat' | 'embedding' | 'reranker';
  status: 'imported' | 'validating' | 'valid' | 'invalid' | 'active' | 'error';
  validationError: string | null;
  metadata: Record<string, any>;
  hardwareCompatibility: HardwareCompatibility;
  importedBy: string | null;
  importedAt: string;
  activatedAt: string | null;
  lastUsedAt: string | null;
}

export interface HardwareCompatibility {
  status: 'RECOMMENDED' | 'COMPATIBLE' | 'LIMITED' | 'NOT_RECOMMENDED' | 'UNSUPPORTED';
  estimatedMemoryMB: number;
  estimatedVramMB: number;
  warnings: string[];
  reasons: string[];
}

export interface Collection {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  visibility: 'private' | 'shared' | 'public';
  embeddingModelId: string;
  embeddingConfig: EmbeddingConfig;
  chunkingConfig: ChunkingConfig;
  documentCount: number;
  chunkCount: number;
  totalSizeBytes: number;
  status: 'active' | 'archived' | 'reindexing';
  createdAt: string;
  updatedAt: string;
  reindexRequired: boolean;
  reindexReason: string | null;
  permission?: 'read' | 'write' | 'admin';
}

export interface EmbeddingConfig {
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  hybridAlpha: number;
  enableReranking: boolean;
}

export interface ChunkingConfig {
  chunkSize: number;
  chunkOverlap: number;
  minChunkSize: number;
  respectBoundaries: boolean;
}

export interface Document {
  id: string;
  collectionId: string;
  filename: string;
  originalFilename: string;
  filepath: string;
  mimeType: string;
  sizeBytes: number;
  fileHash: string;
  pageCount: number | null;
  language: string | null;
  status: 'queued' | 'validating' | 'parsing' | 'chunking' | 'embedding' | 'indexing' | 'ready' | 'failed' | 'disabled';
  errorMessage: string | null;
  chunkCount: number;
  embeddedModelId: string | null;
  embeddedConfig: EmbeddingConfig | null;
  uploadedBy: string;
  uploadedAt: string;
  processedAt: string | null;
  disabledAt: string | null;
  ingestionStage: string | null;
  ingestionProgress: number | null;
}

export interface SelectedDocumentFile {
  path: string;
  name: string;
  size: number;
}

export interface Conversation {
  id: string;
  userId: string;
  title: string;
  modelId: string | null;
  collectionId: string | null;
  systemPrompt: string | null;
  temperature: number;
  maxTokens: number;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationUpdate {
  title?: string;
  modelId?: string | null;
  collectionId?: string | null;
  systemPrompt?: string | null;
  temperature?: number;
  maxTokens?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modelId: string | null;
  tokenCount: number | null;
  generationTimeMs: number | null;
  citations: Citation[];
  metadata: Record<string, any>;
  createdAt: string;
}

export interface Citation {
  chunkId: string;
  documentId: string;
  documentName: string;
  collectionName: string;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  score: number;
  preview: string;
}

export interface SearchResult {
  chunkId: string;
  documentId: string;
  collectionId: string;
  content: string;
  score: number;
  pageStart: number;
  pageEnd: number;
  sectionTitle: string | null;
  metadata: Record<string, any>;
}

export interface ChatRequest {
  conversationId: string;
  message: string;
  modelId?: string;
  collectionId?: string;
  stream: boolean;
  temperature: number;
  maxTokens: number;
}

export interface ChatChunk {
  id: string;
  delta: string;
  finishReason: string | null;
  citations?: Citation[];
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface JobProgress {
  id: string;
  documentId: string;
  collectionId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  priority: number;
  currentStage: string;
  progress: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface HealthStatus {
  backend: 'healthy' | 'degraded' | 'unhealthy';
  database: 'healthy' | 'degraded' | 'unhealthy';
  modelRuntime: 'healthy' | 'degraded' | 'unhealthy';
  embeddingRuntime: 'healthy' | 'degraded' | 'unhealthy';
  storage: {
    freeGB: number;
    totalGB: number;
    usagePercent: number;
  };
  memory: {
    usedMB: number;
    availableMB: number;
  };
  jobWorkers: {
    active: number;
    queued: number;
  };
}

export interface Settings {
  appearance: {
    theme: 'light' | 'dark' | 'system';
    language: string;
    sidebarCollapsed: boolean;
    compactMode: boolean;
  };
  models: {
    defaultChatModelId: string | null;
    defaultEmbeddingModelId: string | null;
    modelDirectory: string;
    defaultContextLength: number;
    defaultThreads: number;
    defaultGpuLayers: number;
  };
  knowledge: {
    defaultChunkSize: number;
    defaultChunkOverlap: number;
    defaultTopK: number;
    hybridAlpha: number;
    enableReranking: boolean;
    rerankerModelId: string | null;
  };
  storage: {
    dataLocation: string;
    modelStorage: string;
    knowledgeStorage: string;
  };
  security: {
    sessionTimeoutMinutes: number;
    maxFailedLogins: number;
    lockoutDurationMinutes: number;
    passwordMinLength: number;
    requireSpecialChars: boolean;
  };
  diagnostics: {
    logLevel: 'debug' | 'info' | 'warn' | 'error';
    enableTelemetry: boolean;
    autoCheckUpdates: boolean;
    debugMode: boolean;
  };
}

export interface HardwareInfo {
  osName: string;
  osVersion: string;
  cpuName: string;
  cpuCoresLogical: number;
  cpuCoresPhysical: number;
  totalMemoryGB: number;
  availableMemoryGB: number;
  gpus: GPUInfo[];
  dataDiskFreeGB: number;
  llamaCppVersion: string;
  supportsCuda: boolean;
  supportsVulkan: boolean;
  supportsMetal: boolean;
}

export interface GPUInfo {
  name: string;
  vendor: string;
  vramTotalGB: number;
  vramFreeGB: number;
  driverVersion: string;
  cudaVersion: string | null;
}

export interface ResourceEstimate {
  modelSizeMB: number;
  estimatedRAMMB: number;
  estimatedVRAMMB: number;
  kvCacheMBPer1kTokens: number;
  compatibility: HardwareCompatibility['status'];
  warnings: string[];
  reasons: string[];
}

export interface BackupOptions {
  includeModels: boolean;
  includeKnowledge: boolean;
  destination: string;
}

export interface BackupResult {
  path: string;
  size: number;
  createdAt: string;
}

export interface RestoreResult {
  success: boolean;
  previousBackup?: string;
}

export interface DataPaths {
  appData: string;
  models: string;
  knowledge: string;
  logs: string;
  cache: string;
}

export interface JobFilter {
  status?: string;
  priority?: number;
  limit?: number;
  offset?: number;
}

export interface AuditFilter {
  actorId?: string;
  action?: string;
  resourceType?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  outcome: 'success' | 'failure';
  metadata: Record<string, any>;
  ipAddress: string;
}

export interface Role {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  isSystem: boolean;
}

export interface Permission {
  id: string;
  name: string;
  description: string;
  resource: string;
  action: string;
}
