import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { ScrollArea } from '@/components/common/ScrollArea';
import {
  Send, Square, Copy, Loader2, ChevronDown, ChevronUp,
  FileText, Copy as CopyIcon, Check, X, Settings,
  Brain, Database, Zap, Trash2, Edit2
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Conversation, Message, Citation, Model, Collection } from '@/types';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const StreamingMarkdown = ({ content, citations }: { content: string; citations: Citation[] }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      code: ({ children, className, ...props }) => {
        const language = className?.replace('language-', '') || '';
        const source = String(children).replace(/\n$/, '');
        return (
          <div className="relative group my-2">
            <pre className="bg-muted rounded-lg p-4 overflow-x-auto">
              <code className={`language-${language}`} {...props}>{children}</code>
            </pre>
            <Button
              variant="ghost"
              size="sm"
              className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => navigator.clipboard.writeText(source)}
            >
              <CopyIcon className="w-4 h-4" />
            </Button>
          </div>
        );
      },
      blockquote: ({ children, ...props }) => (
        <blockquote className="border-l-4 border-primary pl-4 italic text-muted-foreground my-4" {...props}>
          {children}
        </blockquote>
      ),
    }}
  >
    {content}
  </ReactMarkdown>
);

export const ChatView = () => {
  const { conversationId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [selectedCollection, setSelectedCollection] = useState<string>('');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [currentGenerationId, setCurrentGenerationId] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [showModelSelect, setShowModelSelect] = useState(false);
  const [showCollectionSelect, setShowCollectionSelect] = useState(false);
  const [loading, setLoading] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadData();
  }, [conversationId]);

  const loadData = async () => {
    if (conversationId === 'new') {
      // Create new conversation
      try {
        const newConv = await nocaiAPI.chat.createConversation();
        navigate(`/chats/${newConv.id}`, { replace: true });
      } catch (error) {
        console.error('Failed to create conversation:', error);
      }
      return;
    }

    try {
      const [conv, msgs, modelsData, collectionsData] = await Promise.all([
        nocaiAPI.chat.getConversations().then(cs => cs.find(c => c.id === conversationId)),
        nocaiAPI.chat.getMessages(conversationId!),
        nocaiAPI.models.listModels('chat'),
        nocaiAPI.knowledge.listCollections(),
      ]);

      if (conv) {
        setConversation(conv);
        setSelectedModel(conv.modelId || '');
        setSelectedCollection(conv.collectionId || '');
      }
      
      setModels(modelsData);
      setCollections(collectionsData);
      
      setMessages(msgs);
    } catch (error) {
      console.error('Failed to load chat data:', error);
    } finally {
      setLoading(false);
    }
  };

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streaming, scrollToBottom]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || streaming) return;

    if (!conversation) return;

    const userMessage = input.trim();
    setInput('');
    setStreaming(true);
    setGenerating(true);
    setError(null);

    const generationId = `gen-${Date.now()}`;
    setCurrentGenerationId(generationId);

    try {
      const request = {
        conversationId: conversation.id,
        message: userMessage,
        modelId: selectedModel || undefined,
        collectionId: selectedCollection || undefined,
        stream: true,
        temperature: 0.7,
        maxTokens: 4096,
      };

      // Optimistically add user message
      const tempUserMessage: Message = {
        id: `temp-${Date.now()}`,
        conversationId: conversation.id,
        role: 'user',
        content: userMessage,
        modelId: selectedModel || null,
        tokenCount: null,
        generationTimeMs: null,
        citations: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      };
      setMessages(prev => [...prev, tempUserMessage]);

      const stream = await nocaiAPI.chat.sendMessage(request);
      let assistantContent = '';
      let assistantCitations: Citation[] = [];

      for await (const chunk of stream) {
        if (chunk.delta) {
          assistantContent += chunk.delta;
        }
        if (chunk.citations) {
          assistantCitations = chunk.citations;
        }
        if (chunk.finishReason) {
          break;
        }
        
        // Update streaming message
        setMessages(prev => {
          const last = prev[prev.length - 1];
          if (last && last.role === 'assistant' && last.id.startsWith('stream-')) {
            return [...prev.slice(0, -1), { ...last, content: assistantContent, citations: assistantCitations }];
          }
          return [...prev, {
            id: `stream-${generationId}`,
            conversationId: conversation.id,
            role: 'assistant' as const,
            content: assistantContent,
            citations: assistantCitations,
            modelId: selectedModel || null,
            tokenCount: null,
            generationTimeMs: null,
            metadata: {},
            createdAt: new Date().toISOString(),
          }];
        });
      }

      // Final message will be loaded when we refresh
      await loadMessages();
    } catch (err: any) {
      setError(err.message || 'Failed to send message');
    } finally {
      setStreaming(false);
      setGenerating(false);
      setCurrentGenerationId('');
    }
  };

  const loadMessages = async () => {
    if (!conversation) return;
    const persisted = await nocaiAPI.chat.getMessages(conversation.id);
    setMessages(persisted);
  };

  const handleStop = async () => {
    if (currentGenerationId) {
      await nocaiAPI.chat.stopGeneration(currentGenerationId);
      setStreaming(false);
      setGenerating(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const handleModelChange = (modelId: string) => {
    setSelectedModel(modelId);
    setShowModelSelect(false);
    if (conversation) {
      // Update conversation model
    }
  };

  const handleCollectionChange = (collectionId: string) => {
    setSelectedCollection(collectionId);
    setShowCollectionSelect(false);
    if (conversation) {
      // Update conversation collection
    }
  };

  const selectedModelObj = models.find(m => m.id === selectedModel);
  const selectedCollectionObj = collections.find(c => c.id === selectedCollection);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (!conversation) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Conversation not found</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Chat Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3 bg-background">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" onClick={() => navigate('/chats')}>
            <ChevronDown className="w-4 h-4" />
          </Button>
          <div>
            <h2 className="font-semibold text-foreground">{conversation.title}</h2>
            <p className="text-sm text-muted-foreground">
              {messages.length} messages
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Model Selector */}
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setShowModelSelect(!showModelSelect)}
            >
              <Brain className="w-4 h-4" />
              {selectedModelObj?.name || 'Select Model'}
              <ChevronDown className="w-4 h-4" />
            </Button>
            {showModelSelect && (
              <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-lg shadow-lg z-10">
                {models.map(model => (
                  <button
                    key={model.id}
                    onClick={() => handleModelChange(model.id)}
                    className={clsx(
                      'w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors',
                      selectedModel === model.id && 'bg-accent'
                    )}
                  >
                    <div className="font-medium">{model.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {model.parameterCount} • {model.quantization}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Collection Selector */}
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              onClick={() => setShowCollectionSelect(!showCollectionSelect)}
            >
              <Database className="w-4 h-4" />
              {selectedCollectionObj?.name || 'No Knowledge'}
              <ChevronDown className="w-4 h-4" />
            </Button>
            {showCollectionSelect && (
              <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-lg shadow-lg z-10">
                <button
                  onClick={() => handleCollectionChange('')}
                  className={clsx(
                    'w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors',
                    !selectedCollection && 'bg-accent'
                  )}
                >
                  <div className="font-medium">No Knowledge (Model Only)</div>
                </button>
                <hr className="border-border my-1" />
                {collections.map(collection => (
                  <button
                    key={collection.id}
                    onClick={() => handleCollectionChange(collection.id)}
                    className={clsx(
                      'w-full px-3 py-2 text-left text-sm hover:bg-accent transition-colors',
                      selectedCollection === collection.id && 'bg-accent'
                    )}
                  >
                    <div className="font-medium">{collection.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {collection.documentCount} docs
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <Button variant="ghost" size="sm" onClick={() => {}}>
            <Settings className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 overflow-y-auto p-4 space-y-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <Brain className="w-16 h-16 text-muted-foreground/50 mb-4" />
            <h3 className="text-lg font-medium text-foreground mb-2">
              Start a conversation
            </h3>
            <p className="text-muted-foreground max-w-md">
              Ask questions, analyze documents, or explore your knowledge base.
            </p>
          </div>
        ) : (
          <>
            {messages.map((message, index) => (
              <MessageBubble
                key={`${message.id}-${index}`}
                message={message}
                isStreaming={message.id.startsWith('stream-') && streaming}
                onCopy={handleCopy}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </ScrollArea>

      {/* Error Banner */}
      {error && (
        <div className="mx-4 mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-destructive text-sm flex items-center justify-between">
          <span>{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      )}

      {/* Input Area */}
      <div className="border-t border-border bg-background p-4">
        <form onSubmit={handleSend} className="flex items-end gap-3">
          <div className="flex-1 relative">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend(e);
                }
              }}
              placeholder={streaming ? 'Generating...' : 'Message NOC AI Assistant... (Shift+Enter for new line)'}
              disabled={streaming}
              className="w-full min-h-[44px] max-h-64 px-4 py-3 pr-12 bg-card border border-input rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              rows={1}
            />
          </div>
          <div className="flex items-center gap-1">
            {streaming ? (
              <Button
                variant="outline"
                size="sm"
                onClick={handleStop}
                className="text-destructive border-destructive hover:bg-destructive/10"
              >
                <Square className="w-4 h-4 mr-1" />
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!input.trim()}
                className="rounded-full p-2"
              >
                <Send className="w-5 h-5" />
              </Button>
            )}
          </div>
        </form>
        <p className="text-xs text-muted-foreground text-center mt-2">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </div>
  );
};

const MessageBubble = ({ message, isStreaming, onCopy }: { message: Message; isStreaming: boolean; onCopy: (text: string) => void }) => {
  const [showCitations, setShowCitations] = useState(false);

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-3 text-primary-foreground">
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-3 max-w-[90%]">
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Brain className="w-5 h-5 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="bg-card border border-border rounded-2xl p-4">
          <StreamingMarkdown content={message.content} citations={message.citations || []} />
          
          {message.citations && message.citations.length > 0 && (
            <div className="mt-4 border-t border-border pt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-foreground">Sources</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowCitations(!showCitations)}
                >
                  {showCitations ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </Button>
              </div>
              {showCitations && (
                <div className="space-y-2">
                  {message.citations.map((citation, index) => (
                    <CitationCard key={citation.chunkId} citation={citation} index={index + 1} onCopy={onCopy} />
                  ))}
                </div>
              )}
            </div>
          )}
          
          <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
            <Button variant="ghost" size="sm" onClick={() => onCopy(message.content)}>
              <Copy className="w-4 h-4" />
              Copy
            </Button>
            {isStreaming && (
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" />
                Generating...
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const CitationCard = ({ citation, index, onCopy }: { citation: Citation; index: number; onCopy: (text: string) => void }) => {
  const [expanded, setExpanded] = useState(false);
  
  return (
    <div className="bg-muted/50 rounded-lg p-3 border border-border">
      <div className="flex items-start gap-3">
        <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 text-primary text-xs font-medium flex items-center justify-center">
          {index}
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-foreground">{citation.documentName}</span>
            <Badge variant="secondary" className="text-xs">{citation.collectionName}</Badge>
            {citation.pageStart && (
              <Badge variant="outline" className="text-xs">Page {citation.pageStart}</Badge>
            )}
            {citation.sectionTitle && (
              <Badge variant="outline" className="text-xs">{citation.sectionTitle}</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{citation.preview}</p>
          {expanded && (
            <p className="text-sm text-foreground mt-2 font-mono bg-background p-2 rounded border border-border">
              {citation.preview}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show more'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onCopy(citation.preview)}>
              <Copy className="w-3 h-3" />
            </Button>
            <span className="text-xs text-muted-foreground">Score: {citation.score.toFixed(3)}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
