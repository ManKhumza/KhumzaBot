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
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Citation, Collection, Conversation, Message, Model } from '@/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [currentGenerationId, setCurrentGenerationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showCollectionSelect, setShowCollectionSelect] = useState(false);
  const [savingPreference, setSavingPreference] = useState<'model' | 'collection' | null>(null);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    if (conversationId === 'new') {
      try {
        const newConversation = await nocaiAPI.chat.createConversation();
        navigate(`/chats/${newConversation.id}`, { replace: true });
      } catch (loadFailure) {
        setLoadError(loadFailure instanceof Error ? loadFailure.message : 'Could not create a conversation.');
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
      const [conversationData, messageData, modelData, collectionData] = await Promise.all([
        nocaiAPI.chat.getConversations().then((items) => items.find((item) => item.id === conversationId)),
        nocaiAPI.chat.getMessages(conversationId),
        nocaiAPI.models.listModels('chat'),
        nocaiAPI.knowledge.listCollections(),
      ]);

      if (!conversationData) {
        setConversation(null);
        setLoadError('This conversation no longer exists.');
        return;
      }

      const activeModels = modelData.filter((model) => model.status === 'active');
      const activeCollections = collectionData.filter((collection) => collection.status === 'active');
      const savedModelIsActive = activeModels.some((model) => model.id === conversationData.modelId);
      const savedCollectionExists = activeCollections.some((collection) => collection.id === conversationData.collectionId);

      setConversation(conversationData);
      setMessages(messageData);
      setModels(activeModels);
      setCollections(activeCollections);
      setSelectedModel(savedModelIsActive ? conversationData.modelId || '' : activeModels[0]?.id || '');
      setSelectedCollection(savedCollectionExists ? conversationData.collectionId || '' : '');
    } catch (loadFailure) {
      setLoadError(loadFailure instanceof Error ? loadFailure.message : 'Could not load this conversation.');
    } finally {
      setLoading(false);
    }
  }, [conversationId, navigate]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: streaming ? 'auto' : 'smooth' });
  }, [messages, streaming]);

  const refreshMessages = async (id: string) => {
    const persistedMessages = await nocaiAPI.chat.getMessages(id);
    setMessages(persistedMessages);
  };

  const handleSend = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || streaming || !conversation) return;
    if (!selectedModel) {
      setError('Activate a chat model before sending a message.');
      return;
    }

    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = '44px';
    setStreaming(true);
    setError(null);

    const generationId = `gen-${Date.now()}`;
    const temporaryMessageId = `temp-${Date.now()}`;
    setCurrentGenerationId(generationId);

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
    } catch (sendFailure) {
      setError(sendFailure instanceof Error ? sendFailure.message : 'Message generation failed.');
      try {
        await refreshMessages(conversation.id);
      } catch {
        setMessages((current) => current.filter((message) => message.id !== temporaryMessageId));
      }
    } finally {
      setStreaming(false);
      setCurrentGenerationId('');
      textareaRef.current?.focus();
    }
  };

  const handleStop = async () => {
    if (!currentGenerationId) return;
    try {
      await nocaiAPI.chat.stopGeneration(currentGenerationId);
    } catch (stopFailure) {
      setError(stopFailure instanceof Error ? stopFailure.message : 'Could not stop generation.');
    } finally {
      setStreaming(false);
      setCurrentGenerationId('');
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
    setInput(prompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const selectedModelObject = models.find((model) => model.id === selectedModel);
  const selectedCollectionObject = collections.find((collection) => collection.id === selectedCollection);

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
              className="max-w-56 gap-2"
              onClick={() => {
                setShowModelSelect((open) => !open);
                setShowCollectionSelect(false);
              }}
              disabled={savingPreference !== null}
              aria-expanded={showModelSelect}
            >
              {savingPreference === 'model' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
              <span className="truncate">{selectedModelObject?.name || 'No chat model'}</span>
              <ChevronDown className="h-4 w-4 flex-none" />
            </Button>
            {showModelSelect && (
              <div className="absolute right-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                {models.length > 0 ? models.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => handleModelChange(model.id)}
                    className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <span className={clsx('mt-1 h-2 w-2 flex-none rounded-full', selectedModel === model.id ? 'bg-primary' : 'bg-transparent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{model.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
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
              className="max-w-52 gap-2"
              onClick={() => {
                setShowCollectionSelect((open) => !open);
                setShowModelSelect(false);
              }}
              disabled={savingPreference !== null}
              aria-expanded={showCollectionSelect}
            >
              {savingPreference === 'collection' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Database className="h-4 w-4" />}
              <span className="truncate">{selectedCollectionObject?.name || 'Model only'}</span>
              <ChevronDown className="h-4 w-4 flex-none" />
            </Button>
            {showCollectionSelect && (
              <div className="absolute right-0 top-full z-20 mt-1 w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg">
                <button
                  onClick={() => handleCollectionChange('')}
                  className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm hover:bg-accent"
                >
                  <span className={clsx('h-2 w-2 rounded-full', !selectedCollection ? 'bg-primary' : 'bg-transparent')} />
                  <span className="font-medium">Model only</span>
                </button>
                {collections.map((collection) => (
                  <button
                    key={collection.id}
                    onClick={() => handleCollectionChange(collection.id)}
                    className="flex w-full items-start gap-3 border-t border-border px-3 py-2.5 text-left text-sm hover:bg-accent"
                  >
                    <span className={clsx('mt-1 h-2 w-2 flex-none rounded-full', selectedCollection === collection.id ? 'bg-primary' : 'bg-transparent')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{collection.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {collection.documentCount} document{collection.documentCount === 1 ? '' : 's'}
                      </span>
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
        <form onSubmit={handleSend} className="mx-auto flex w-full max-w-4xl items-end gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
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
            disabled={streaming || !selectedModel}
            className="min-h-11 max-h-40 flex-1 resize-none rounded-md border border-input bg-card px-3.5 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
            rows={1}
            aria-label="Message"
          />
          {streaming ? (
            <Button type="button" variant="outline" onClick={handleStop} className="h-11 gap-2 text-destructive">
              <Square className="h-4 w-4" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          ) : (
            <Button type="submit" className="h-11 w-11 p-0" disabled={!input.trim() || !selectedModel} aria-label="Send message">
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
