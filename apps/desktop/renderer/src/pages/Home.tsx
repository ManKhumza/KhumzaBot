import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { relativeTime } from '@/utils/date';
import { Button } from '@/components/common/Button';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  Clock3,
  Cpu,
  Database,
  FileText,
  HardDrive,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
  Server,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Collection, Conversation, HardwareInfo, HealthStatus, Model } from '@/types';

type Readiness = 'ready' | 'attention' | 'optional';

const ReadinessItem = ({
  icon,
  label,
  detail,
  status,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  status: Readiness;
}) => (
  <div className="flex min-w-0 items-start gap-3 px-4 py-4 sm:px-5">
    <div className={clsx(
      'mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-md',
      status === 'ready' && 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
      status === 'attention' && 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
      status === 'optional' && 'bg-muted text-muted-foreground'
    )}>
      {icon}
    </div>
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold">{label}</p>
        <span className={clsx(
          'h-1.5 w-1.5 flex-none rounded-full',
          status === 'ready' && 'bg-emerald-500',
          status === 'attention' && 'bg-amber-500',
          status === 'optional' && 'bg-muted-foreground/50'
        )} />
      </div>
      <p className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</p>
    </div>
  </div>
);

const Metric = ({ label, value, detail }: { label: string; value: string; detail: string }) => (
  <div className="min-w-0 px-4 py-5 sm:px-5">
    <p className="text-xs font-medium uppercase text-muted-foreground">{label}</p>
    <p className="mt-2 truncate text-2xl font-semibold">{value}</p>
    <p className="mt-1 truncate text-xs text-muted-foreground">{detail}</p>
  </div>
);

export const Home = () => {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const isAdministrator = Boolean(user?.roles.includes('administrator'));
  const [serviceReady, setServiceReady] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const requests: [
      Promise<{ status: string; service: string }>,
      Promise<Model[]>,
      Promise<Collection[]>,
      Promise<Conversation[]>,
      Promise<HardwareInfo>,
      Promise<HealthStatus | null>,
    ] = [
      nocaiAPI.system.getHealth(),
      nocaiAPI.models.listModels(),
      nocaiAPI.knowledge.listCollections(),
      nocaiAPI.chat.getConversations(),
      nocaiAPI.models.getHardwareInfo(),
      isAdministrator ? nocaiAPI.admin.getHealth() : Promise.resolve(null),
    ];

    const [serviceResult, modelsResult, collectionsResult, conversationsResult, hardwareResult, healthResult] =
      await Promise.allSettled(requests);

    setServiceReady(serviceResult.status === 'fulfilled' && serviceResult.value.status === 'ready');
    setModels(modelsResult.status === 'fulfilled' ? modelsResult.value : []);
    setCollections(collectionsResult.status === 'fulfilled' ? collectionsResult.value : []);
    setConversations(conversationsResult.status === 'fulfilled' ? conversationsResult.value : []);
    setHardware(hardwareResult.status === 'fulfilled' ? hardwareResult.value : null);
    setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);

    const essentialFailures = [serviceResult, modelsResult, conversationsResult]
      .filter((result) => result.status === 'rejected').length;
    if (essentialFailures > 0) {
      setLoadError('Some workspace details could not be loaded.');
    }
    setLoading(false);
  }, [isAdministrator]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const activeChatModel = models.find((model) => model.role === 'chat' && model.status === 'active');
  const activeEmbeddingModel = models.find((model) => model.role === 'embedding' && model.status === 'active');
  const modelRuntimeReady = health ? health.modelRuntime === 'healthy' : Boolean(activeChatModel);
  const chatReady = serviceReady && Boolean(activeChatModel) && modelRuntimeReady;
  const readyDocuments = collections.reduce((total, collection) => total + collection.documentCount, 0);
  const totalChunks = collections.reduce((total, collection) => total + collection.chunkCount, 0);
  const knowledgeReady = Boolean(activeEmbeddingModel) && totalChunks > 0;
  const recentConversations = conversations.slice(0, 5);
  const recentCollections = collections.slice(0, 5);

  if (loading) {
    return (
      <div className="flex h-full min-h-72 items-center justify-center">
        <Loader2 className="h-7 w-7 animate-spin text-primary" aria-label="Loading overview" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm text-muted-foreground">Welcome back, {user?.displayName || user?.username}</p>
          <h2 className="mt-1 text-2xl font-semibold">Your local operations workspace</h2>
        </div>
        <Button onClick={() => navigate(chatReady ? '/chats/new' : '/models')}>
          {chatReady ? <Plus className="mr-2 h-4 w-4" /> : <Cpu className="mr-2 h-4 w-4" />}
          {chatReady ? 'New chat' : 'Set up chat model'}
        </Button>
      </div>

      {loadError && (
        <div className="flex items-center justify-between gap-4 border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm" role="status">
          <div className="flex items-center gap-2 text-amber-800 dark:text-amber-300">
            <AlertTriangle className="h-4 w-4 flex-none" />
            <span>{loadError}</span>
          </div>
          <Button variant="ghost" size="sm" onClick={loadData}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        </div>
      )}

      <section aria-labelledby="readiness-heading">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h3 id="readiness-heading" className="text-sm font-semibold">Workspace readiness</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">Live state of the local assistant</p>
          </div>
          <span className={clsx(
            'rounded-full px-2.5 py-1 text-xs font-semibold',
            chatReady
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
          )}>
            {chatReady ? 'Ready for chat' : 'Setup needed'}
          </span>
        </div>
        <div className="grid overflow-hidden border-y border-border sm:grid-cols-3 sm:divide-x sm:divide-y-0 divide-y divide-border">
          <ReadinessItem
            icon={<Server className="h-4 w-4" />}
            label="Local services"
            detail={serviceReady ? 'Backend and database are available' : 'Service requires attention'}
            status={serviceReady ? 'ready' : 'attention'}
          />
          <ReadinessItem
            icon={<Cpu className="h-4 w-4" />}
            label="Chat model"
            detail={activeChatModel?.name || 'No active GGUF chat model'}
            status={activeChatModel && modelRuntimeReady ? 'ready' : 'attention'}
          />
          <ReadinessItem
            icon={<Database className="h-4 w-4" />}
            label="Knowledge"
            detail={knowledgeReady ? `${readyDocuments} documents indexed` : 'Optional document context is not ready'}
            status={knowledgeReady ? 'ready' : 'optional'}
          />
        </div>
      </section>

      {!chatReady && (
        <section className="grid gap-5 border border-primary/25 bg-primary/5 p-5 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Activity className="h-5 w-5" />
              <h3 className="font-semibold">Complete chat setup</h3>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-background text-xs font-semibold">1</span>
                Import a GGUF model
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-background text-xs font-semibold">2</span>
                Check compatibility
              </div>
              <div className="flex items-center gap-2 text-sm">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-background text-xs font-semibold">3</span>
                Activate for chat
              </div>
            </div>
          </div>
          <Button variant="outline" onClick={() => navigate('/models')}>
            Open models <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </section>
      )}

      <section aria-label="Workspace metrics">
        <div className="grid divide-y divide-border border-y border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-4">
          <Metric
            label="Conversations"
            value={String(conversations.length)}
            detail={conversations.length ? `Latest updated ${relativeTime(conversations[0].updatedAt)}` : 'No saved conversations'}
          />
          <Metric
            label="Collections"
            value={String(collections.length)}
            detail={`${readyDocuments} document${readyDocuments === 1 ? '' : 's'}`}
          />
          <Metric
            label="Indexed chunks"
            value={totalChunks.toLocaleString()}
            detail={activeEmbeddingModel?.name || 'No embedding model active'}
          />
          <Metric
            label="Storage used"
            value={health ? `${health.storage.usagePercent.toFixed(1)}%` : 'Unavailable'}
            detail={health ? `${health.storage.freeGB.toFixed(1)} GB free` : 'Visible to administrators'}
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-2">
        <section aria-labelledby="recent-chats-heading">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 id="recent-chats-heading" className="text-sm font-semibold">Recent conversations</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Continue where you left off</p>
            </div>
            <Link to="/chats" className="text-xs font-semibold text-primary hover:underline">View all</Link>
          </div>
          <div className="border-y border-border divide-y divide-border">
            {recentConversations.length > 0 ? recentConversations.map((conversation) => (
              <Link
                key={conversation.id}
                to={`/chats/${conversation.id}`}
                className="group flex items-center gap-3 px-2 py-3 hover:bg-accent/60"
              >
                <MessageSquare className="h-4 w-4 flex-none text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{conversation.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{relativeTime(conversation.updatedAt)}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </Link>
            )) : (
              <div className="flex items-center gap-3 px-2 py-5 text-sm text-muted-foreground">
                <MessageSquare className="h-4 w-4" />
                No conversations yet
              </div>
            )}
          </div>
        </section>

        <section aria-labelledby="knowledge-heading">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <h3 id="knowledge-heading" className="text-sm font-semibold">Knowledge collections</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">Local context available to chat</p>
            </div>
            <Link to="/knowledge" className="text-xs font-semibold text-primary hover:underline">Manage</Link>
          </div>
          <div className="border-y border-border divide-y divide-border">
            {recentCollections.length > 0 ? recentCollections.map((collection) => (
              <Link key={collection.id} to="/knowledge" className="flex items-center gap-3 px-2 py-3 hover:bg-accent/60">
                <FileText className="h-4 w-4 flex-none text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{collection.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {collection.documentCount} documents, {collection.chunkCount.toLocaleString()} chunks
                  </p>
                </div>
                {collection.chunkCount > 0 ? (
                  <Check className="h-4 w-4 text-emerald-600" aria-label="Indexed" />
                ) : (
                  <Clock3 className="h-4 w-4 text-muted-foreground" aria-label="Waiting for documents" />
                )}
              </Link>
            )) : (
              <div className="flex items-center gap-3 px-2 py-5 text-sm text-muted-foreground">
                <Database className="h-4 w-4" />
                No knowledge collections
              </div>
            )}
          </div>
        </section>
      </div>

      {(health || hardware) && (
        <section className="border-t border-border pt-5" aria-labelledby="machine-heading">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <div>
              <h3 id="machine-heading" className="flex items-center gap-2 text-sm font-semibold">
                <HardDrive className="h-4 w-4 text-muted-foreground" />
                This machine
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {hardware ? `${hardware.cpuName} with ${hardware.totalMemoryGB.toFixed(1)} GB RAM` : 'Local resource status'}
              </p>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
              {hardware && <span>{hardware.availableMemoryGB.toFixed(1)} GB memory available</span>}
              {health && <span>{health.jobWorkers.active} active jobs, {health.jobWorkers.queued} queued</span>}
              {health && (
                <span className="flex items-center gap-1.5">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', health.database === 'healthy' ? 'bg-emerald-500' : 'bg-amber-500')} />
                  Database {health.database}
                </span>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
};
