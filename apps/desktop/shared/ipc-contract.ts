/**
 * Shared contract for IPC calls that cross the preload/main boundary.
 * Channel values preserve the application's existing public API.
 */

export const IPC = {
  CHAT_SEND: 'nocai:chat:sendMessage',
  CHAT_STOP: 'nocai:chat:stopGeneration',
  CHAT_RENAME: 'nocai:chat:renameConversation',
  CHAT_LOAD: 'nocai:chat:getMessages',
  KNOWLEDGE_UPLOAD: 'nocai:knowledge:uploadDocuments',
  KNOWLEDGE_REPROCESS: 'nocai:knowledge:reprocessDocument',
  SYSTEM_VERSION: 'nocai:system:getVersion',
  SYSTEM_SHUTDOWN: 'nocai:system:shutdown',
} as const;

export interface ChatSendPayload {
  conversationId: string;
  message: string;
  modelId?: string;
  collectionId?: string;
  stream?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface RenamePayload {
  id: string;
  title: string;
}

export interface ChatLoadPayload {
  conversationId: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeUploadPayload {
  collectionId: string;
  filePaths: string[];
}

export interface ReprocessPayload {
  documentId: string;
}

export type IpcInvokeMap = {
  [IPC.CHAT_SEND]: (payload: ChatSendPayload) => Promise<unknown>;
  [IPC.CHAT_STOP]: (generationId: string) => Promise<unknown>;
  [IPC.CHAT_RENAME]: (payload: RenamePayload) => Promise<unknown>;
  [IPC.CHAT_LOAD]: (payload: ChatLoadPayload) => Promise<unknown[]>;
  [IPC.KNOWLEDGE_UPLOAD]: (payload: KnowledgeUploadPayload) => Promise<unknown>;
  [IPC.KNOWLEDGE_REPROCESS]: (payload: ReprocessPayload) => Promise<unknown>;
  [IPC.SYSTEM_VERSION]: () => Promise<string>;
  [IPC.SYSTEM_SHUTDOWN]: () => Promise<void>;
};
