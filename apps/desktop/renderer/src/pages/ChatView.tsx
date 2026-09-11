import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Badge } from '@/components/common/Badge';
import { ScrollArea } from '@/components/common/ScrollArea';
import {
  ArrowLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Loader2,
  RotateCcw,
  Send,
  Square,
  X,
  Zap,
  Settings as SettingsIcon,
  Plus,
  MessageSquare,
  FileText,
  FolderOpen,
  AlertCircle,
  CheckCircle,
  Clock,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Citation, Collection, Conversation, Message, Model, Settings } from '@/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { chatDrafts } from '@/stores/chatDrafts';
import { userFacingError } from '@/utils/errors';

const suggestedPrompts = [
  'Summarize this incident timeline and identify the likely trigger.',
  'Draft a safe rollback plan with validation checkpoints.',
  'Explain this log pattern and suggest the next three checks.',
  'Turn these notes into a concise shift handover.',
];

const MarkdownMessage = ({ content }: { content: string }) => (
  <div className="prose max-w-none text-sm">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: ({ children, className, ...props }) => {
          const isBlock = Boolean(className) || String(children).includes('\n');
          return (
            <code
              className={clsx(
                className,
                !isBlock && 'rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]'
              )}
              {...props}
            >
              {children}
            </code>
          );
        },
        pre: ({ children, ...props }) => (
          <pre className="my-3 overflow-x-auto rounded-md bg-muted p-4 text-sm" {...props}>
            {children}
          </pre>
        ),
        blockquote: ({ children, ...props }) => (
          <blockquote className="my-4 border-l-2 border-primary pl-4 text-muted-foreground" {...props}>
            {children}
          </blockquote>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  </div>
);

export const ChatView = () => {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedCollection, setSelectedCollection] = useState('');
  const [behavior, setBehavior] = useState<Settings['behavior'] | null>(null);
  const [input, setInput] = useState(() => chatDrafts.get(conversationId || 'new'));
  const [streaming, setStreaming] = useState(false);
  const [currentGenerationId, setCurrentGenerationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showCollectionSelect, setShowCollectionSelect] = useState(false);
  const [savingPreference, setSavingPreference] = useState<'model' | 'collection' | null>(null);
  const [loading, setLoading] = useState(true);
  const [backendReady, setBackendReady] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const generationRef = useRef<string | null>(null);
  const stopRequested = useRef(false);
  const routeRef = useRef(conversationId);
  const loadSequence = useRef(0);
  const creation = useRef<Promise<Conversation> | null>(null);
  const readinessFlight = useRef<Promise<Model[]> | null>(null);
  routeRef.current = conversationId;

  const updateInput = (value: string) => {
    setInput(value);
    if (conversationId) chatDrafts.set(conversationId, value);
  };

  const refreshReadiness = useCallback(async () => {
    if (readinessFlight.current) return readinessFlight.current;
    readinessFlight.current = (async () => {
      try {
        const [health, listedModels] = await Promise.all([nocaiAPI.system.getHealth(), nocaiAPI.models.listModels('chat')]);
        const activeModels = listedModels.filter((model) => model.status === 'active');
        setModels(activeModels);
        setBackendReady(health.status === 'ready' || health.status === 'degraded');
        return activeModels;
      } catch {
        setBackendReady(false);
        return [];
      }
    })();
    try { return await readinessFlight.current; }
    finally { readinessFlight.current = null; }
  }, []);

  const loadData = useCallback(async () => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setLoadError(null);
    setError(null);

    if (conversationId === 'new') {
      try {
        if (!creation.current) creation.current = nocaiAPI.chat.createConversation();
        const newConversation = await creation.current;
        if (loadSequence.current !== sequence) return;
        navigate(`/chats/${newConversation.id}`, { replace: true });
      } catch (loadFailure) {
        creation.current = null;
        if (loadSequence.current !== sequence) return;
        setLoadError(userFacingError(loadFailure, 'Could not create a conversation.'));
        setLoading(false);
      }
      return;
    }

    if (!conversationId) {
      setLoadError('Conversation not found.');
      setLoading(false);
      return;
    }

    try {
      const [conversationData, messageData, modelData, collectionData, settingsData] = await Promise.all([
        nocaiAPI.chat.getConversations().then((items) => items.find((item) => item.id === conversationId)),
        nocaiAPI.chat.getMessages(conversationId),
        nocaiAPI.models.listModels('chat'),
        nocaiAPI.knowledge.listCollections(),
        nocaiAPI.settings.get(),
      ]);
      if (loadSequence.current !== sequence) return;

      if (!conversationData) {
        setConversation(null);
        setLoadError('This conversation no longer exists.');
        return;
      }

      const activeModels = modelData.filter((model) => model.status === 'active');
      const activeCollections = collectionData.filter((collection) => collection.status === 'active');
      const savedModelIsActive = activeModels.some((model) => model.id === conversationData.modelId);
      const savedCollectionExists = activeCollections.some((collection) => collection.id === conversationData.collectionId);
      let loadedConversation = conversationData;
      let initialCollectionId = savedCollectionExists ? conversationData.collectionId || '' : '';

      const requiresSelectedKnowledge = settingsData.behavior.responseMode !== 'model_only'
        && settingsData.behavior.knowledgeScope === 'selected_collection';
      const searchableCollections = activeCollections.filter((collection) => collection.chunkCount > 0);
      if (!conversationData.collectionId && requiresSelectedKnowledge && searchableCollections.length === 1) {
        try {
          loadedConversation = await nocaiAPI.chat.updateConversation(conversationData.id, {
            collectionId: searchableCollections[0].id,
          });
          initialCollectionId = searchableCollections[0].id;
        } catch {
          setError('Could not automatically select the ready knowledge source. Select it from the knowledge menu and try again.');
        }
      }

      setConversation(loadedConversation);
      setMessages(messageData);
      setModels(activeModels);
      setCollections(activeCollections);
      setBehavior(settingsData.behavior);
      setSelectedModel(savedModelIsActive ? conversationData.modelId || '' : activeModels[0]?.id || '');
      setSelectedCollection(initialCollectionId);
    } catch (loadFailure) {
      if (loadSequence.current === sequence) setLoadError(userFacingError(loadFailure, 'Could not load this conversation.'));
    } finally {
      if (loadSequence.current === sequence) setLoading(false);
    }
  }, [conversationId, navigate]);

  useEffect(() => {
    setInput(chatDrafts.get(conversationId || 'new'));
    setStreaming(false);
    setCancelling(false);
    void loadData();
    return () => {
      loadSequence.current += 1;
      const generation = generationRef.current;
      generationRef.current = null;
      if (generation) void nocaiAPI.chat.stopGeneration(generation).catch(() => {
        // The main process owns request cleanup and records failed cancellation.
      });
    };
  }, [loadData]);

  useEffect(() => {
    void refreshReadiness();
    const timer = window.setInterval(() => void refreshReadiness(), 5000);
    const unsubscribe = window.nocai?.onBackendStatusChange((status) => {
      if (status.status === 'ready') void refreshReadiness();
      else setBackendReady(false);
    });
    return () => { window.clearInterval(timer); unsubscribe?.(); };
  }, [refreshReadiness]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  const refreshMessages = async (id: string) => {
    const persistedMessages = await nocaiAPI.chat.getMessages(id);
    if (routeRef.current === id) setMessages(persistedMessages);
  };

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || streaming || generationRef.current || !conversation) return;
    if (!backendReady || !models.some((model) => model.id === selectedModel)) {
      setError('Activate a chat model before sending a message.');
      return;
    }

    const requiresSelectedKnowledge = behavior?.responseMode !== 'model_only'
      && behavior?.knowledgeScope === 'selected_collection';
    if (requiresSelectedKnowledge) {
      if (!selectedCollection) {
        setError('Select a knowledge source with indexed documents before sending this message.');
        setShowCollectionSelect(true);
        return;
      }

      const source = collections.find((collection) => collection.id === selectedCollection);
      if (!source || source.chunkCount <= 0) {
        setError(
          source
            ? `${source.name} is not ready for chat because it has no searchable chunks. Finish indexing a document or select another source.`
            : 'The selected knowledge source is unavailable. Select a ready source and try again.'
        );
        setShowCollectionSelect(true);
        return;
      }
    }

    setStreaming(true);
    setError(null);

    const generationId = conversation.id;
    const temporaryMessageId = `temp-${Date.now()}`;
    setCurrentGenerationId(generationId);
    generationRef.current = generationId;
    stopRequested.current = false;

    const temporaryUserMessage: Message = {
      id: temporaryMessageId,
      conversationId: conversation.id,
      role: 'user',
      content,
      modelId: selectedModel,
      tokenCount: null,
      generationTimeMs: null,
      citations: [],
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, temporaryUserMessage]);

    try {
      const readyModels = await refreshReadiness();
      if (routeRef.current !== conversation.id || generationRef.current !== generationId) return;
      if (stopRequested.current) throw new Error('Generation was cancelled.');
      if (!readyModels.some((model) => model.id === selectedModel)) throw new Error('The chat model is unavailable. Open Models to activate it. Your draft has been kept.');
      const stream = await nocaiAPI.chat.sendMessage({
        conversationId: conversation.id,
        message: content,
        modelId: selectedModel,
        collectionId: selectedCollection || undefined,
        stream: true,
        temperature: conversation.temperature,
        maxTokens: conversation.maxTokens,
      });
      let assistantContent = '';
      let assistantCitations: Citation[] = [];

      for await (const chunk of stream) {
        if (routeRef.current !== conversation.id || generationRef.current !== generationId) return;
        assistantContent += chunk.delta || '';
        if (chunk.citations) assistantCitations = chunk.citations;

        setMessages((current) => {
          const last = current[current.length - 1];
          const streamingMessage: Message = {
            id: `stream-${generationId}`,
            conversationId: conversation.id,
            role: 'assistant',
            content: assistantContent,
            citations: assistantCitations,
            modelId: selectedModel,
            tokenCount: null,
            generationTimeMs: null,
            metadata: {},
            createdAt: new Date().toISOString(),
          };
          return last?.id === streamingMessage.id
            ? [...current.slice(0, -1), streamingMessage]
            : [...current, streamingMessage];
        });

        if (chunk.finishReason) break;
      }

      await refreshMessages(conversation.id);
      chatDrafts.set(conversation.id, '');
      if (routeRef.current === conversation.id) setInput('');
    } catch (sendFailure) {
      if (routeRef.current !== conversation.id) return;
      setError(`${userFacingError(sendFailure, 'Message generation failed.')} Your draft has been kept. Review the conversation before sending again.`);
      try {
        await refreshMessages(conversation.id);
      } catch {
        setMessages((current) => current.filter((message) => message.id !== temporaryMessageId));
      }
    } finally {
      if (generationRef.current === generationId) {
        generationRef.current = null;
        setStreaming(false);
        setCancelling(false);
        setCurrentGenerationId('');
        textareaRef.current?.focus();
      }
    }
  };

  const handleStop = async () => {
    if (!currentGenerationId || cancelling) return;
    stopRequested.current = true;
    setCancelling(true);
    try {
      await nocaiAPI.chat.stopGeneration(currentGenerationId);
    } catch (stopFailure) {
      setError(userFacingError(stopFailure, 'Could not stop generation.'));
      setCancelling(false);
    }
  };

  const handleModelChange = async (modelId: string) => {
    if (!conversation || modelId === selectedModel) {
      setShowModelSelect(false);
      return;
    }
    const previousModel = selectedModel;
    setSelectedModel(modelId);
    setShowModelSelect(false);
    setSavingPreference('model');
    try {
      const updated = await nocaiAPI.chat.updateConversation(conversation.id, { modelId });
      setConversation(updated);
    } catch (updateFailure) {
      setSelectedModel(previousModel);
      setError(updateFailure instanceof Error ? updateFailure.message : 'Could not save the model selection.');
    } finally {
      setSavingPreference(null);
    }
  };

  const handleCollectionChange = async (collectionId: string) => {
    if (!conversation || collectionId === selectedCollection) {
      setShowCollectionSelect(false);
      return;
    }
    const previousCollection = selectedCollection;
    setSelectedCollection(collectionId);
    setShowCollectionSelect(false);
    setSavingPreference('collection');
    try {
      const updated = await nocaiAPI.chat.updateConversation(conversation.id, {
        collectionId: collectionId || null,
      });
      setConversation(updated);
    } catch (updateFailure) {
      setSelectedCollection(previousCollection);
      setError(updateFailure instanceof Error ? updateFailure.message : 'Could not save the knowledge selection.');
    } finally {
      setSavingPreference(null);
    }
  };

  const selectPrompt = (prompt: string) => {
    updateInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const selectedModelObject = models.find((model) => model.id === selectedModel);
  const canSend = backendReady && Boolean(selectedModelObject) && savingPreference === null;
  const selectedCollectionObject = collections.find((collection) => collection.id === selectedCollection);
  const knowledgeSelectionEnabled = behavior?.responseMode !== 'model_only' && behavior?.knowledgeScope !== 'all_collections';
  const knowledgeLabel = behavior?.responseMode === 'model_only'
    ? 'Knowledge disabled'
    : behavior?.knowledgeScope === 'all_collections'
      ? 'All knowledge sources'
      : selectedCollectionObject?.name || 'Select knowledge source';

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" aria-label="Loading conversation" />
      </div>
    );
  }

  if (loadError || !conversation) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <X className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-lg font-semibold">Conversation unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">{loadError || 'This conversation could not be found.'}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="outline" onClick={() => navigate('/chats')}>Back to chats</Button>
            <Button onClick={loadData}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex flex-none flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" className="h-8 w-8 flex-none p-0" onClick={() => navigate('/chats')} aria-label="Back to chats">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{conversation.title}</h2>
            <p className="text-xs text-muted-foreground">{messages.length} message{messages.length === 1 ? '' : 's'}</p>
          </div>
        </div>

        <div className="flex min-w-0 gap-2 overflow-x-auto pb-1 sm:justify-end sm:pb-0">
          <div className="relative flex-none">
            <Button
              variant="outline"
              size="sm"
              className="h-10 max-w-72 gap-2 px-4 text-sm"
              onClick={() => {
                setShowModelSelect((open) => !open);
                setShowCollectionSelect(false);
              }}
              disabled={savingPreference !== null || streaming}
              aria-expanded={showModelSelect}
            >
              {savingPreference === 'model' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
              <span className="truncate">{selectedModelObject?.name || 'No chat model'}</span>
              <ChevronDown className="h-4 w-4 flex-none" />
            </Button>
            {showModelSelect && (
              <div className="absolute right-0 top-full z-40 mt-2 max-h-[min(70vh,32rem)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-xl">
                {models.length > 0 ? models.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => handleModelChange(model.id)}
                    className={clsx(
                      'flex min-h-16 w-full items-start gap-3 rounded-md px-4 py-3 text-left text-base hover:bg-accent',
                      selectedModel === model.id && 'bg-accent/70'
                    )}
                  >
                    <span className={clsx('mt-1 flex h-5 w-5 flex-none items-center justify-center rounded-full border', selectedModel === model.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                      {selectedModel === model.id && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-semibold leading-snug">{model.name}</span>
                      <span className="mt-1 block break-words text-sm text-muted-foreground">
                        {[model.parameterCount, model.quantization].filter(Boolean).join(' / ') || 'Active chat model'}
                      </span>
                    </span>
                  </button>
                )) : (
                  <div className="p-3">
                    <p className="text-sm font-medium">No active chat model</p>
                    <Button className="mt-3 w-full" size="sm" onClick={() => navigate('/models')}>Open model manager</Button>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="relative flex-none">
            <Button
              variant="outline"
              size="sm"
              className="h-10 max-w-72 gap-2 px-4 text-sm"
              onClick={() => {
                setShowCollectionSelect((open) => !open);
                setShowModelSelect(false);
              }}
              disabled={savingPreference !== null || streaming || !knowledgeSelectionEnabled}
              aria-expanded={showCollectionSelect}
            >
              {savingPreference === 'collection' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              <span className="truncate">{knowledgeLabel}</span>
              {knowledgeSelectionEnabled && <ChevronDown className="h-4 w-4 flex-none" />}
            </Button>
            {showCollectionSelect && (
              <div className="absolute right-0 top-full z-40 mt-2 max-h-[min(70vh,32rem)] w-[min(30rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-border bg-popover p-2 shadow-xl">
                <button
                  onClick={() => handleCollectionChange('')}
                  className={clsx(
                    'flex min-h-16 w-full items-center gap-3 rounded-md px-4 py-3 text-left text-base hover:bg-accent',
                    !selectedCollection && 'bg-accent/70'
                  )}
                >
                  <span className={clsx('flex h-5 w-5 flex-none items-center justify-center rounded-full border', !selectedCollection ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                    {!selectedCollection && <Check className="h-3 w-3" />}
                  </span>
                  <span>
                    <span className="block font-semibold">No source selected</span>
                    <span className="mt-1 block text-sm text-muted-foreground">Knowledge-only mode will decline unsupported questions.</span>
                  </span>
                </button>
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    onClick={() => handleCollectionChange(collection.id)}
                    className={clsx(
                      'mt-1 flex min-h-20 w-full items-start gap-3 rounded-md px-4 py-3 text-left text-base hover:bg-accent',
                      selectedCollection === collection.id && 'bg-accent/70'
                    )}
                  >
                    <span className={clsx('mt-1 flex h-5 w-5 flex-none items-center justify-center rounded-full border', selectedCollection === collection.id ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}>
                      {selectedCollection === collection.id && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words font-semibold leading-snug">{collection.name}</span>
                      <span className="mt-1 block text-sm text-muted-foreground">
                        {collection.documentCount} document{collection.documentCount === 1 ? '' : 's'} · {collection.chunkCount} searchable chunks
                      </span>
                      {collection.description && <span className="mt-1 line-clamp-2 block text-sm text-muted-foreground">{collection.description}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-6 sm:px-6">
          {messages.length === 0 ? (
            <div className="my-auto py-10">
              <div className="flex h-10 w-10 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Brain className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-xl font-semibold">What are you working through?</h3>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                Use a focused prompt or add context from a local knowledge collection.
              </p>

              {!selectedModel ? (
                <div className="mt-6 flex items-center justify-between gap-4 border border-amber-500/30 bg-amber-500/5 p-4">
                  <p className="text-sm text-amber-800 dark:text-amber-300">A chat model needs to be active.</p>
                  <Button size="sm" onClick={() => navigate('/models')}>Open models</Button>
                </div>
              ) : (
                <div className="mt-7 grid gap-2 sm:grid-cols-2">
                  {suggestedPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => selectPrompt(prompt)}
                      className="min-h-16 border border-border px-4 py-3 text-left text-sm leading-relaxed hover:border-primary/40 hover:bg-accent/50"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-6">
              {messages.map((message, index) => (
                <MessageBubble
                  key={`${message.id}-${index}`}
                  message={message}
                  isStreaming={message.id.startsWith('stream-') && streaming}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </ScrollArea>

      {error && (
        <div className="mx-auto mb-3 flex w-[calc(100%-2rem)] max-w-4xl items-start justify-between gap-3 border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="rounded p-0.5 hover:bg-destructive/10" aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="flex-none border-t border-border bg-background px-4 py-3 sm:px-6">
        <p className="mx-auto mb-2 max-w-4xl text-xs text-muted-foreground" role="status">{cancelling ? 'Cancelling response...' : streaming ? 'Generating response...' : !backendReady ? 'Disconnected. Your draft remains available.' : selectedModelObject ? 'Chat model ready' : 'Activate a chat model in Models to send. You can prepare a draft now.'}</p>
        <form onSubmit={handleSend} className="mx-auto flex w-full max-w-4xl items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              updateInput(event.target.value);
              event.currentTarget.style.height = '44px';
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 160)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                handleSend(event);
              }
            }}
            placeholder={streaming ? 'Generating response...' : selectedModel ? 'Ask about an incident, runbook, or change...' : 'Activate a chat model to begin'}
            disabled={streaming}
            maxLength={32768}
            className="min-h-11 max-h-40 flex-1 resize-none rounded-md border border-input bg-card px-3.5 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            rows={1}
            aria-label="Message"
          />
          {streaming ? (
            <Button type="button" variant="outline" onClick={handleStop} disabled={cancelling} aria-label={cancelling ? 'Cancelling response' : 'Stop response'} className="h-11 gap-2 text-destructive">
              <Square className="h-4 w-4" />
              <span className="hidden sm:inline">{cancelling ? 'Cancelling' : 'Stop'}</span>
            </Button>
          ) : (
            <Button type="submit" className="h-11 w-11 p-0" disabled={!input.trim() || !canSend} aria-label="Send message">
              <Send className="h-4 w-4" />
            </Button>
          )}
        </form>
      </div>
    </div>
  );
};

const MessageBubble = ({ message, isStreaming }: { message: Message; isStreaming: boolean }) => {
  const [showCitations, setShowCitations] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyMessage = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-4 py-3 text-sm leading-relaxed text-primary-foreground sm:max-w-[75%]">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex max-w-full gap-3">
      <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-primary/10 text-primary">
        <Brain className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <MarkdownMessage content={message.content} />

        {message.citations?.length > 0 && (
          <div className="mt-4 border-t border-border pt-3">
            <button
              className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground"
              onClick={() => setShowCitations((shown) => !shown)}
              aria-expanded={showCitations}
            >
              {message.citations.length} source{message.citations.length === 1 ? '' : 's'}
              {showCitations ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            </button>
            {showCitations && (
              <div className="mt-3 space-y-2">
                {message.citations.map((citation, index) => (
                  <CitationCard key={citation.chunkId} citation={citation} index={index + 1} />
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex items-center gap-3">
          <button
            onClick={copyMessage}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            aria-label="Copy response"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {isStreaming && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Generating
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

const CitationCard = ({ citation, index }: { citation: Citation; index: number }) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border bg-muted/30 p-3">
      <div className="flex items-start gap-3">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{citation.documentName}</span>
            <Badge variant="secondary" className="text-xs">{citation.collectionName}</Badge>
            {citation.pageStart > 0 && <Badge variant="outline" className="text-xs">Page {citation.pageStart}</Badge>}
          </div>
          <p className={clsx('mt-1 text-sm text-muted-foreground', !expanded && 'line-clamp-2')}>{citation.preview}</p>
          <div className="mt-2 flex items-center justify-between gap-3">
            <button className="text-xs font-medium text-primary hover:underline" onClick={() => setExpanded((open) => !open)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
            <span className="text-xs text-muted-foreground">Relevance {citation.score.toFixed(2)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
