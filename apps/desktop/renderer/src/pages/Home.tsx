import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import {
  MessageSquare,
  Cpu,
  Database,
  Search,
  Plus,
  ArrowRight,
  CheckCircle,
  AlertCircle,
  Loader2,
  Clock,
  HardDrive,
  Users,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { HealthStatus, HardwareInfo, Model, Collection } from '@/types';

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  trend?: string;
  href?: string;
}

const StatCard = ({ icon, label, value, trend, href }: StatCardProps) => (
  <Card>
    <CardContent className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="text-3xl font-bold text-foreground mt-1">{value}</p>
          {trend && <p className="text-sm text-green-600 dark:text-green-400 mt-1">{trend}</p>}
        </div>
        <div className="p-2 rounded-lg bg-primary/10 text-primary">{icon}</div>
      </div>
      {href && (
        <Link to={href} className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary/80">
          View details <ArrowRight className="w-4 h-4" />
        </Link>
      )}
    </CardContent>
  </Card>
);

interface QuickActionProps {
  icon: React.ReactNode;
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}

const QuickAction = ({ icon, label, description, onClick, disabled }: QuickActionProps) => (
  <Button
    variant="outline"
    className="w-full justify-start gap-3 p-4"
    onClick={onClick}
    disabled={disabled}
  >
    <div className="p-2 rounded-lg bg-primary/10 text-primary">{icon}</div>
    <div className="flex-1 text-left">
      <p className="font-medium text-foreground">{label}</p>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
    <ArrowRight className="w-4 h-4 text-muted-foreground" />
  </Button>
);

export const Home = () => {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [healthData, hardwareData, modelsData, collectionsData] = await Promise.allSettled([
          nocaiAPI.admin.getHealth(),
          nocaiAPI.models.getHardwareInfo(),
          nocaiAPI.models.listModels(),
          nocaiAPI.knowledge.listCollections(),
        ]);

        setHealth(healthData.status === 'fulfilled' ? healthData.value : null);
        setHardware(hardwareData.status === 'fulfilled' ? hardwareData.value : null);
        setModels(modelsData.status === 'fulfilled' ? modelsData.value : []);
        setCollections(collectionsData.status === 'fulfilled' ? collectionsData.value : []);
      } catch (error) {
        console.error('Failed to load home data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []);

  const activeChatModel = models.find(m => m.role === 'chat' && m.status === 'active');
  const activeEmbeddingModel = models.find(m => m.role === 'embedding' && m.status === 'active');

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Welcome Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Welcome back, {user?.displayName || user?.username}
          </h1>
          <p className="text-muted-foreground mt-1">
            Your private, local AI assistant for Network Operations Centre tasks
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={health?.backend === 'healthy' ? 'success' : 'destructive'} className="gap-1">
            <CheckCircle className="w-3 h-3" />
            {health?.backend === 'healthy' ? 'Backend Ready' : 'Backend Issue'}
          </Badge>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={<MessageSquare className="w-6 h-6" />}
          label="Active Chat Model"
          value={activeChatModel?.name || 'None'}
          href="/models"
        />
        <StatCard
          icon={<Cpu className="w-6 h-6" />}
          label="Active Embedding Model"
          value={activeEmbeddingModel?.name || 'None'}
          href="/models"
        />
        <StatCard
          icon={<Database className="w-6 h-6" />}
          label="Knowledge Collections"
          value={collections.length}
          href="/knowledge"
        />
        <StatCard
          icon={<HardDrive className="w-6 h-6" />}
          label="Storage Used"
          value={`${((health?.storage.usagePercent || 0) * 100).toFixed(1)}%`}
          trend={`${health?.storage.freeGB.toFixed(1)} GB free`}
        />
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle>Quick Actions</CardTitle>
          <CardDescription>Common tasks to get started</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <QuickAction
              icon={<Plus className="w-5 h-5" />}
              label="New Chat"
              description="Start a new conversation"
              onClick={() => navigate('/chats/new')}
            />
            <QuickAction
              icon={<Cpu className="w-5 h-5" />}
              label="Import Model"
              description="Add a local GGUF model"
              onClick={() => navigate('/models')}
            />
            <QuickAction
              icon={<Database className="w-5 h-5" />}
              label="Create Collection"
              description="Organize your documents"
              onClick={() => navigate('/knowledge')}
            />
            <QuickAction
              icon={<Search className="w-5 h-5" />}
              label="Search Knowledge"
              description="Query your documents directly"
              onClick={() => navigate('/search')}
            />
          </div>
        </CardContent>
      </Card>

      {/* System Status */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>System Health</CardTitle>
            <CardDescription>Current system status and resource usage</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'w-3 h-3 rounded-full',
                  health?.backend === 'healthy' && 'bg-green-500',
                  health?.backend === 'degraded' && 'bg-yellow-500',
                  health?.backend === 'unhealthy' && 'bg-red-500'
                )} />
                <span>Backend API</span>
              </div>
              <Badge variant={health?.backend === 'healthy' ? 'success' : health?.backend === 'degraded' ? 'warning' : 'destructive'}>
                {health?.backend || 'Unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'w-3 h-3 rounded-full',
                  health?.database === 'healthy' && 'bg-green-500',
                  health?.database === 'degraded' && 'bg-yellow-500',
                  health?.database === 'unhealthy' && 'bg-red-500'
                )} />
                <span>Database</span>
              </div>
              <Badge variant={health?.database === 'healthy' ? 'success' : health?.database === 'degraded' ? 'warning' : 'destructive'}>
                {health?.database || 'Unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'w-3 h-3 rounded-full',
                  health?.modelRuntime === 'healthy' && 'bg-green-500',
                  health?.modelRuntime === 'degraded' && 'bg-yellow-500',
                  health?.modelRuntime === 'unhealthy' && 'bg-red-500'
                )} />
                <span>Model Runtime</span>
              </div>
              <Badge variant={health?.modelRuntime === 'healthy' ? 'success' : health?.modelRuntime === 'degraded' ? 'warning' : 'destructive'}>
                {health?.modelRuntime || 'Unknown'}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className={clsx(
                  'w-3 h-3 rounded-full',
                  health?.embeddingRuntime === 'healthy' && 'bg-green-500',
                  health?.embeddingRuntime === 'degraded' && 'bg-yellow-500',
                  health?.embeddingRuntime === 'unhealthy' && 'bg-red-500'
                )} />
                <span>Embedding Runtime</span>
              </div>
              <Badge variant={health?.embeddingRuntime === 'healthy' ? 'success' : health?.embeddingRuntime === 'degraded' ? 'warning' : 'destructive'}>
                {health?.embeddingRuntime || 'Unknown'}
              </Badge>
            </div>
            {hardware && (
              <>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-muted-foreground" />
                    <span>Available Memory</span>
                  </span>
                  <span className="font-mono text-foreground">{hardware.availableMemoryGB.toFixed(1)} GB / {hardware.totalMemoryGB.toFixed(1)} GB</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                    <span>Disk Space</span>
                  </span>
                  <span className="font-mono text-foreground">{health?.storage.freeGB.toFixed(1)} GB free of {health?.storage.totalGB.toFixed(1)} GB</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
            <CardDescription>Latest conversations and document updates</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {models.filter(m => m.status === 'active').length > 0 ? (
                models.filter(m => m.status === 'active').slice(0, 3).map(model => (
                  <div key={model.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Cpu className="w-5 h-5 text-primary" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">{model.name}</p>
                      <p className="text-sm text-muted-foreground">{model.role} • {model.quantization}</p>
                    </div>
                    <Badge variant="success">Active</Badge>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-center py-4">No active models. <Link to="/models" className="text-primary hover:underline">Import a model</Link> to get started.</p>
              )}
              
              <hr className="border-border my-2" />
              
              {collections.length > 0 ? (
                collections.slice(0, 3).map(collection => (
                  <div key={collection.id} className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                    <Database className="w-5 h-5 text-blue-500" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">{collection.name}</p>
                      <p className="text-sm text-muted-foreground">{collection.documentCount} docs • {collection.chunkCount} chunks</p>
                    </div>
                    <Badge variant="default">{collection.status}</Badge>
                  </div>
                ))
              ) : (
                <p className="text-muted-foreground text-center py-4">No collections yet. <Link to="/knowledge" className="text-primary hover:underline">Create a collection</Link> to organize documents.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
