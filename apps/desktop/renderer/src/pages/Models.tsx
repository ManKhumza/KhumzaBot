import React, { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Plus, Trash2, Play, Pause, Cpu, HardDrive, Download, Upload, Search, Loader2, AlertTriangle, CheckCircle, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { Model, HardwareInfo, ResourceEstimate } from '@/types';

export const Models = () => {
  const { user } = useAuthStore();
  const [models, setModels] = useState<Model[]>([]);
  const [chatModels, setChatModels] = useState<Model[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [hardware, setHardware] = useState<HardwareInfo | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importPath, setImportPath] = useState('');
  const [importRole, setImportRole] = useState<'chat' | 'embedding'>('chat');
  const [importName, setImportName] = useState('');
  const [importing, setImporting] = useState(false);
  const [scanResults, setScanResults] = useState<any[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showScanResults, setShowScanResults] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [modelsData, hardwareData] = await Promise.all([
        nocaiAPI.models.listModels(),
        nocaiAPI.models.getHardwareInfo(),
      ]);
      setModels(modelsData);
      setChatModels(modelsData.filter(m => m.role === 'chat'));
      setEmbeddingModels(modelsData.filter(m => m.role === 'embedding'));
      setHardware(hardwareData);
    } catch (error) {
      console.error('Failed to load models:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleScan = async () => {
    if (!importPath) return;
    setScanning(true);
    try {
      const results = await nocaiAPI.models.scanDirectory(importPath);
      setScanResults(results.models);
      setShowScanResults(true);
    } catch (error) {
      console.error('Scan failed:', error);
    } finally {
      setScanning(false);
    }
  };

  const handleImport = async () => {
    if (!importPath) return;
    setImporting(true);
    try {
      await nocaiAPI.models.importModel({
        sourcePath: importPath,
        role: importRole,
        name: importName || undefined,
      });
      setShowImportDialog(false);
      setImportPath('');
      setImportName('');
      await loadData();
    } catch (error) {
      console.error('Import failed:', error);
    } finally {
      setImporting(false);
    }
  };

  const handleActivate = async (modelId: string, role: 'chat' | 'embedding') => {
    setActivatingId(modelId);
    try {
      await nocaiAPI.models.activateModel(modelId, role);
      await loadData();
    } catch (error) {
      console.error('Activate failed:', error);
    } finally {
      setActivatingId(null);
    }
  };

  const handleDeactivate = async (modelId: string) => {
    try {
      await nocaiAPI.models.deactivateModel(modelId);
      await loadData();
    } catch (error) {
      console.error('Deactivate failed:', error);
    }
  };

  const handleDelete = async (modelId: string) => {
    try {
      await nocaiAPI.models.deleteModel(modelId);
      await loadData();
    } catch (error) {
      console.error('Delete failed:', error);
    } finally {
      setShowDeleteConfirm(false);
      setDeletingId(null);
    }
  };

  const handleEstimate = async (path: string) => {
    try {
      return await nocaiAPI.models.estimateModelRequirements(path);
    } catch {
      return null;
    }
  };

  const getCompatibilityColor = (status: string) => {
    switch (status) {
      case 'RECOMMENDED': return 'success';
      case 'COMPATIBLE': return 'default';
      case 'LIMITED': return 'warning';
      case 'NOT_RECOMMENDED': return 'destructive';
      case 'UNSUPPORTED': return 'destructive';
      default: return 'default';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Models</h1>
          <p className="text-muted-foreground">Manage your local AI models</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setShowImportDialog(true)}>
            <Upload className="w-4 h-4 mr-2" />
            Import Model
          </Button>
          <Button onClick={() => setShowImportDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Scan Directory
          </Button>
        </div>
      </div>

      {/* Hardware Info */}
      {hardware && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Cpu className="w-5 h-5" />
              System Information
            </CardTitle>
            <CardDescription>Hardware capabilities for model inference</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">CPU</p>
                <p className="font-mono text-foreground">{hardware.cpuName}</p>
                <p className="text-xs text-muted-foreground">{hardware.cpuCoresPhysical}C / {hardware.cpuCoresLogical}T</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">RAM</p>
                <p className="font-mono text-foreground">{hardware.totalMemoryGB.toFixed(1)} GB</p>
                <p className="text-xs text-muted-foreground">{hardware.availableMemoryGB.toFixed(1)} GB available</p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">GPU</p>
                <p className="font-mono text-foreground">{hardware.gpus.length > 0 ? hardware.gpus[0].name : 'None'}</p>
                <p className="text-xs text-muted-foreground">
                  {hardware.gpus.length > 0 ? `${hardware.gpus[0].vramTotalGB.toFixed(1)} GB VRAM` : 'CPU only'}
                </p>
              </div>
              <div className="p-3 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground">llama.cpp</p>
                <p className="font-mono text-foreground">{hardware.llamaCppVersion}</p>
                <p className="text-xs text-muted-foreground">
                  {hardware.supportsCuda ? 'CUDA ' : ''}
                  {hardware.supportsVulkan ? 'Vulkan ' : ''}
                  {hardware.supportsMetal ? 'Metal ' : ''}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Chat Models */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <Cpu className="w-5 h-5" />
            Chat Models ({chatModels.length})
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {chatModels.map(model => (
            <ModelCard
              key={model.id}
              model={model}
              hardware={hardware}
              onActivate={() => handleActivate(model.id, 'chat')}
              onDeactivate={() => handleDeactivate(model.id)}
              onDelete={() => { setDeletingId(model.id); setShowDeleteConfirm(true); }}
              activating={activatingId === model.id}
            />
          ))}
          {chatModels.length === 0 && (
            <Card className="col-span-full text-center py-12">
              <CardContent>
                <Cpu className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">No chat models imported</h3>
                <p className="text-muted-foreground mb-4">Import a GGUF model to start chatting</p>
                <Button onClick={() => setShowImportDialog(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Import Model
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Embedding Models */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
            <HardDrive className="w-5 h-5" />
            Embedding Models ({embeddingModels.length})
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {embeddingModels.map(model => (
            <ModelCard
              key={model.id}
              model={model}
              hardware={hardware}
              onActivate={() => handleActivate(model.id, 'embedding')}
              onDeactivate={() => handleDeactivate(model.id)}
              onDelete={() => { setDeletingId(model.id); setShowDeleteConfirm(true); }}
              activating={activatingId === model.id}
            />
          ))}
          {embeddingModels.length === 0 && (
            <Card className="col-span-full text-center py-12">
              <CardContent>
                <HardDrive className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">No embedding models imported</h3>
                <p className="text-muted-foreground mb-4">Import a GGUF embedding model for knowledge retrieval</p>
                <Button onClick={() => setShowImportDialog(true)} variant="outline">
                  <Plus className="w-4 h-4 mr-2" />
                  Import Model
                </Button>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Import Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog} title="Import Model" description="Select a local GGUF model file or scan a directory">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1">Model Directory</label>
            <div className="flex gap-2">
              <Input
                value={importPath}
                onChange={(e) => setImportPath(e.target.value)}
                placeholder="C:\\Models or /home/user/models"
              />
              <Button variant="outline" onClick={handleScan} isLoading={scanning}>
                <Search className="w-4 h-4" />
                Scan
              </Button>
            </div>
          </div>

          {showScanResults && scanResults.length > 0 && (
            <div className="border border-border rounded-lg max-h-64 overflow-y-auto">
              {scanResults.map((result: any) => (
                <div key={result.filepath} className="border-b border-border p-3 hover:bg-accent/50">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{result.suggestedName || result.filename}</p>
                      <p className="text-sm text-muted-foreground">
                        {result.suggestedRole} • {(result.sizeBytes / (1024**3)).toFixed(2)} GB
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => {
                      setImportPath(result.filepath);
                      setImportRole(result.suggestedRole || 'chat');
                      setImportName(result.suggestedName || '');
                    }}>
                      Import
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Role</label>
              <select
                value={importRole}
                onChange={(e) => setImportRole(e.target.value as 'chat' | 'embedding')}
                className="w-full h-10 px-3 border border-input rounded-lg bg-background"
              >
                <option value="chat">Chat Model</option>
                <option value="embedding">Embedding Model</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Name (optional)</label>
              <Input value={importName} onChange={(e) => setImportName(e.target.value)} placeholder="Auto-detected from model" />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowImportDialog(false)}>Cancel</Button>
            <Button onClick={handleImport} isLoading={importing} disabled={!importPath}>
              {importing ? 'Importing...' : 'Import Model'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Model"
        description="Are you sure you want to delete this model? This will remove the model file permanently."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => deletingId && handleDelete(deletingId)}
        variant="destructive"
      />
    </div>
  );
};

const ModelCard = ({ model, hardware, onActivate, onDeactivate, onDelete, activating }: { 
  model: Model; 
  hardware: HardwareInfo | null;
  onActivate: () => void;
  onDeactivate: () => void;
  onDelete: () => void;
  activating: boolean;
}) => {
  const compat = model.hardwareCompatibility;
  const compatColor = compat?.status ? 
    (compat.status === 'RECOMMENDED' ? 'success' : 
     compat.status === 'COMPATIBLE' ? 'default' :
     compat.status === 'LIMITED' ? 'warning' : 'destructive') : 'default';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>{model.name}</CardTitle>
            <p className="text-sm text-muted-foreground">{model.filename}</p>
          </div>
          <Badge variant={model.status === 'active' ? 'success' : 'secondary'}>
            {model.status === 'active' ? 'Active' : model.status}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div>
            <p className="text-muted-foreground">Architecture</p>
            <p className="font-medium">{model.architecture || 'Unknown'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Quantization</p>
            <p className="font-medium">{model.quantization || 'Unknown'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Parameters</p>
            <p className="font-medium">{model.parameterCount || 'Unknown'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Context</p>
            <p className="font-medium">{model.contextLength?.toLocaleString() || 'Unknown'}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Size</p>
            <p className="font-medium">{(model.sizeBytes / (1024**3)).toFixed(2)} GB</p>
          </div>
          <div>
            <p className="text-muted-foreground">Format</p>
            <p className="font-medium">{model.format}</p>
          </div>
        </div>

        {compat && (
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center justify-between mb-2">
              <span className="font-medium">Compatibility</span>
              <Badge variant={compatColor}>{compat.status}</Badge>
            </div>
            <div className="text-sm text-muted-foreground">
              Est. RAM: {compat.estimatedMemoryMB?.toFixed(0)} MB
              {compat.estimatedVramMB && compat.estimatedVramMB > 0 && (
                <> | Est. VRAM: {compat.estimatedVramMB.toFixed(0)} MB</>
              )}
            </div>
            {compat.warnings.length > 0 && (
              <div className="mt-2 text-xs text-destructive">
                {compat.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
              </div>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex items-center justify-between">
        <div className="flex gap-2">
          {model.status === 'active' ? (
            <Button variant="outline" size="sm" onClick={onDeactivate} disabled={activating}>
              <Pause className="w-4 h-4 mr-1" /> Deactivate
            </Button>
          ) : (
            <Button size="sm" onClick={onActivate} disabled={activating}>
              <Play className="w-4 h-4 mr-1" /> Activate
            </Button>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onDelete} className="text-destructive hover:text-destructive">
          <Trash2 className="w-4 h-4" />
        </Button>
      </CardFooter>
    </Card>
  );
};