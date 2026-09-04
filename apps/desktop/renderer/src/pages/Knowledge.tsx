import React, { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Textarea } from '@/components/common/Textarea';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Plus, Trash2, Upload, Download, FileText, Loader2, Search, Settings, AlertTriangle, Eye, Edit2, Database, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { Collection, Document } from '@/types';

export const Knowledge = () => {
  const { user } = useAuthStore();
  const [collections, setCollections] = useState<Collection[]>([]);
  const [selectedCollection, setSelectedCollection] = useState<Collection | null>(null);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [models, setModels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [collectionLoading, setCollectionLoading] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [newCollectionName, setNewCollectionName] = useState('');
  const [newCollectionDesc, setNewCollectionDesc] = useState('');
  const [selectedEmbeddingModel, setSelectedEmbeddingModel] = useState('');
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
  const [showDeleteCollectionConfirm, setShowDeleteCollectionConfirm] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [showDeleteDocConfirm, setShowDeleteDocConfirm] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!selectedCollection || !documents.some(doc =>
      ['queued', 'validating', 'parsing', 'chunking', 'embedding', 'indexing'].includes(doc.status)
    )) return;
    const timer = window.setTimeout(() => handleSelectCollection(selectedCollection), 1000);
    return () => window.clearTimeout(timer);
  }, [selectedCollection, documents]);

  const loadData = async () => {
    try {
      const [collectionsData, modelsData] = await Promise.all([
        nocaiAPI.knowledge.listCollections(),
        nocaiAPI.models.listModels('embedding'),
      ]);
      setCollections(collectionsData);
      setModels(modelsData);
      if (modelsData.length > 0 && !selectedEmbeddingModel) {
        setSelectedEmbeddingModel(modelsData[0].id);
      }
    } catch (error) {
      console.error('Failed to load knowledge:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCollection = async (collection: Collection) => {
    setSelectedCollection(collection);
    setCollectionLoading(true);
    try {
      const docs = await nocaiAPI.knowledge.listDocuments(collection.id);
      setDocuments(docs);
    } catch (error) {
      console.error('Failed to load documents:', error);
    } finally {
      setCollectionLoading(false);
    }
  };

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim() || !selectedEmbeddingModel) return;
    try {
      await nocaiAPI.knowledge.createCollection({
        name: newCollectionName.trim(),
        description: newCollectionDesc.trim() || undefined,
        embeddingModelId: selectedEmbeddingModel,
        embeddingConfig: {
          chunkSize: 512,
          chunkOverlap: 50,
          topK: 10,
          hybridAlpha: 0.5,
          enableReranking: false,
        },
        chunkingConfig: {
          chunkSize: 512,
          chunkOverlap: 50,
          minChunkSize: 50,
          respectBoundaries: true,
        },
      });
      setShowCreateDialog(false);
      setNewCollectionName('');
      setNewCollectionDesc('');
      await loadData();
    } catch (error) {
      console.error('Failed to create collection:', error);
    }
  };

  const handleUpload = async () => {
    if (uploadFiles.length === 0 || !selectedCollection) return;
    setUploading(true);
    try {
      await nocaiAPI.knowledge.uploadDocuments(selectedCollection.id, uploadFiles);
      setShowUploadDialog(false);
      setUploadFiles([]);
      await handleSelectCollection(selectedCollection);
    } catch (error) {
      console.error('Failed to upload:', error);
    } finally {
      setUploading(false);
    }
  };

  const handleReprocess = async (docId: string) => {
    try {
      await nocaiAPI.knowledge.reprocessDocument(docId);
      await handleSelectCollection(selectedCollection!);
    } catch (error) {
      console.error('Failed to reprocess:', error);
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    try {
      await nocaiAPI.knowledge.deleteDocument(docId);
      await handleSelectCollection(selectedCollection!);
    } catch (error) {
      console.error('Failed to delete document:', error);
    } finally {
      setShowDeleteDocConfirm(false);
      setDeletingDocId(null);
    }
  };

  const handleDeleteCollection = async (collectionId: string) => {
    try {
      await nocaiAPI.knowledge.deleteCollection(collectionId);
      setCollections(prev => prev.filter(c => c.id !== collectionId));
      if (selectedCollection?.id === collectionId) {
        setSelectedCollection(null);
      }
    } catch (error) {
      console.error('Failed to delete collection:', error);
    } finally {
      setShowDeleteCollectionConfirm(false);
      setDeletingCollectionId(null);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'ready': return 'success';
      case 'queued': case 'validating': case 'parsing': case 'chunking': case 'embedding': case 'indexing': return 'default';
      case 'failed': return 'destructive';
      case 'disabled': return 'secondary';
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
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Knowledge</h1>
          <p className="text-muted-foreground">Manage document collections and ingestion</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="w-4 h-4 mr-2" />
            New Collection
          </Button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        {/* Collections Sidebar */}
        <Card className="w-80 flex-shrink-0 flex flex-col h-full">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2">
              <Database className="w-5 h-5" />
              Collections ({collections.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 overflow-y-auto p-0">
            {collections.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center px-8 py-8">
                <Database className="w-12 h-12 text-muted-foreground/50 mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">No collections yet</h3>
                <p className="text-muted-foreground mb-4">Create a collection to organize your documents</p>
                <Button onClick={() => setShowCreateDialog(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Create Collection
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {collections.map(collection => (
                  <button
                    key={collection.id}
                    onClick={() => handleSelectCollection(collection)}
                    className={clsx(
                      'w-full p-4 text-left hover:bg-accent/50 transition-colors flex items-center justify-between',
                      selectedCollection?.id === collection.id && 'bg-accent/50'
                    )}
                  >
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground truncate">{collection.name}</p>
                      <p className="text-sm text-muted-foreground truncate">
                        {collection.documentCount} docs • {collection.chunkCount} chunks
                      </p>
                    </div>
                    <Badge variant={collection.status === 'active' ? 'success' : 'secondary'}>
                      {collection.status}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Documents Panel */}
        <div className="flex-1 flex flex-col ml-4 min-w-0">
          {selectedCollection ? (
            <>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">{selectedCollection.name}</h2>
                  <p className="text-sm text-muted-foreground">
                    {selectedCollection.documentCount} documents • {selectedCollection.chunkCount} chunks
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => setShowUploadDialog(true)} disabled={!selectedCollection}>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Documents
                  </Button>
                </div>
              </div>

              <Card className="flex-1 overflow-hidden">
                <CardContent className="p-0 h-full">
                  {documents.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center px-8">
                      <FileText className="w-12 h-12 text-muted-foreground/50 mb-4" />
                      <h3 className="text-lg font-medium text-foreground mb-2">No documents yet</h3>
                      <p className="text-muted-foreground mb-4">Upload documents to build your knowledge base</p>
                      <Button onClick={() => setShowUploadDialog(true)}>
                        <Upload className="w-4 h-4 mr-2" />
                        Upload Documents
                      </Button>
                    </div>
                  ) : (
                    <div className="h-full overflow-y-auto">
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-border">
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Document</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Pages</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Chunks</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Size</th>
                            <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Actions</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {documents.map(doc => (
                            <tr key={doc.id} className="hover:bg-accent/50">
                              <td className="px-4 py-3">
                                <p className="font-medium text-foreground truncate max-w-xs">{doc.originalFilename}</p>
                                <p className="text-xs text-muted-foreground">{doc.mimeType}</p>
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant={getStatusColor(doc.status)}>{doc.status}</Badge>
                                {doc.errorMessage && (
                                  <p className="mt-1 max-w-xs text-xs text-destructive">{doc.errorMessage}</p>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{doc.pageCount || '-'}</td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{doc.chunkCount}</td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{(doc.sizeBytes / 1024).toFixed(1)} KB</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                  {doc.status === 'failed' && (
                                    <Button variant="ghost" size="sm" onClick={() => handleReprocess(doc.id)}>
                                      <RefreshCw className="w-4 h-4" />
                                    </Button>
                                  )}
                                  <Button variant="ghost" size="sm" onClick={() => { setDeletingDocId(doc.id); setShowDeleteDocConfirm(true); }}>
                                    <Trash2 className="w-4 h-4" />
                                  </Button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : (
            <Card className="flex-1 flex items-center justify-center">
              <CardContent className="text-center">
                <Database className="w-16 h-16 text-muted-foreground/50 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-foreground mb-2">Select a collection</h3>
                <p className="text-muted-foreground">Choose a collection from the sidebar to manage its documents</p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Create Collection Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog} title="Create Collection">
        <div className="space-y-4">
          <Input
            label="Name"
            value={newCollectionName}
            onChange={(e) => setNewCollectionName(e.target.value)}
            placeholder="e.g., Cisco Procedures"
            autoFocus
          />
          <Textarea
            label="Description (optional)"
            value={newCollectionDesc}
            onChange={(e) => setNewCollectionDesc(e.target.value)}
            placeholder="Description of this collection"
            rows={3}
          />
          <div>
            <label className="block text-sm font-medium mb-1">Embedding Model</label>
            <select
              value={selectedEmbeddingModel}
              onChange={(e) => setSelectedEmbeddingModel(e.target.value)}
              className="w-full h-10 px-3 border border-input rounded-lg bg-background"
            >
              {models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateCollection} disabled={!newCollectionName.trim() || !selectedEmbeddingModel}>
              Create Collection
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Upload Documents Dialog */}
      <Dialog open={showUploadDialog} onOpenChange={setShowUploadDialog} title="Upload Documents" description="Select files to add to the collection">
        <div className="space-y-4">
          <div
            className="border-2 border-dashed border-border rounded-lg p-8 text-center hover:border-primary/50 transition-colors"
            onClick={() => document.getElementById('file-upload')?.click()}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove('border-primary'); }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-primary');
              const files = Array.from(e.dataTransfer.files);
              setUploadFiles(prev => [...prev, ...files]);
            }}
          >
            <input
              id="file-upload"
              type="file"
              multiple
              accept=".txt,.md,.pdf,.docx,.csv,.html"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setUploadFiles(prev => [...prev, ...files]);
              }}
              className="hidden"
            />
            <Upload className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <p className="text-foreground">Drag & drop files here, or click to browse</p>
            <p className="text-sm text-muted-foreground mt-1">Supported: .txt, .md, .pdf, .docx, .csv, .html</p>
          </div>

          {uploadFiles.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {uploadFiles.map((file, index) => (
                <div key={index} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium truncate max-w-[200px]">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setUploadFiles(prev => prev.filter((_, i) => i !== index))}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setShowUploadDialog(false); setUploadFiles([]); }}>Cancel</Button>
            <Button onClick={handleUpload} disabled={uploadFiles.length === 0 || uploading || !selectedCollection} isLoading={uploading}>
              {uploading ? 'Uploading...' : 'Upload Documents'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete Document Confirmation */}
      <AlertDialog
        open={showDeleteDocConfirm}
        onOpenChange={setShowDeleteDocConfirm}
        title="Delete Document"
        description="Are you sure you want to delete this document? This will also remove all its chunks and embeddings."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => deletingDocId && handleDeleteDoc(deletingDocId)}
        variant="destructive"
      />

      {/* Delete Collection Confirmation */}
      <AlertDialog
        open={showDeleteCollectionConfirm}
        onOpenChange={setShowDeleteCollectionConfirm}
        title="Delete Collection"
        description="Are you sure you want to delete this collection? All documents and embeddings will be permanently removed."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => deletingCollectionId && handleDeleteCollection(deletingCollectionId)}
        variant="destructive"
      />
    </div>
  );
};
