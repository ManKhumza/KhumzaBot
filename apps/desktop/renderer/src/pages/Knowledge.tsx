import React, { useState, useEffect, useRef } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { userFacingError } from '@/utils/errors';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Textarea } from '@/components/common/Textarea';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Plus, Trash2, Upload, Download, FileText, Loader2, Search, Settings, AlertTriangle, Eye, Edit2, Database, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import type { Collection, Document, SelectedDocumentFile } from '@/types';

const processingStatuses = ['queued', 'validating', 'parsing', 'chunking', 'embedding', 'indexing'];

const formatFileSize = (bytes: number) => {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
};

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
  const [uploadFiles, setUploadFiles] = useState<SelectedDocumentFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deletingCollectionId, setDeletingCollectionId] = useState<string | null>(null);
  const [showDeleteCollectionConfirm, setShowDeleteCollectionConfirm] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);
  const [showDeleteDocConfirm, setShowDeleteDocConfirm] = useState(false);
  const collectionRequestRef = useRef(0);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (!selectedCollection || !documents.some(doc => processingStatuses.includes(doc.status))) return;
    const timer = window.setTimeout(() => handleSelectCollection(selectedCollection), 2000);
    return () => window.clearTimeout(timer);
  }, [selectedCollection, documents]);

  const loadData = async () => {
    setError(null);
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
      setError(error instanceof Error ? error.message : 'Could not load knowledge collections.');
    } finally {
      setLoading(false);
    }
  };

  const handleSelectCollection = async (collection: Collection) => {
    const requestId = ++collectionRequestRef.current;
    setSelectedCollection(collection);
    setCollectionLoading(true);
    try {
      const docs = await nocaiAPI.knowledge.listDocuments(collection.id);
      if (requestId === collectionRequestRef.current) setDocuments(docs);
    } catch (error) {
      console.error('Failed to load documents:', error);
      if (requestId === collectionRequestRef.current) {
        setError(error instanceof Error ? error.message : 'Could not load documents.');
      }
    } finally {
      if (requestId === collectionRequestRef.current) setCollectionLoading(false);
    }
  };

  const handleCreateCollection = async () => {
    if (!newCollectionName.trim() || !selectedEmbeddingModel) return;
    setError(null);
    try {
      await nocaiAPI.knowledge.createCollection({
        name: newCollectionName.trim(),
        description: newCollectionDesc.trim() || undefined,
        embeddingModelId: selectedEmbeddingModel,
        embeddingConfig: {
          chunkSize: 384,
          chunkOverlap: 50,
          topK: 10,
          hybridAlpha: 0.5,
          enableReranking: false,
        },
        chunkingConfig: {
          chunkSize: 384,
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
      setError(error instanceof Error ? error.message : 'Could not create the collection.');
    }
  };

  const addUploadFiles = (files: SelectedDocumentFile[]) => {
    setUploadFiles((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]));
      files.forEach((file) => byPath.set(file.path, file));
      return [...byPath.values()];
    });
  };

  const handleBrowseDocuments = async () => {
    setUploadError(null);
    try {
      addUploadFiles(await nocaiAPI.knowledge.selectDocuments());
    } catch (browseError) {
      setUploadError(userFacingError(browseError, 'Could not open the document picker.'));
    }
  };

  const handleDroppedFiles = (files: File[]) => {
    const selected = files.flatMap((file) => {
      const path = (file as File & { path?: string }).path;
      return path ? [{ path, name: file.name, size: file.size }] : [];
    });
    if (!selected.length && files.length) {
      setUploadError('Dropped file paths are unavailable. Use the file picker instead.');
      return;
    }
    addUploadFiles(selected);
  };

  const handleUpload = async () => {
    if (uploadFiles.length === 0 || !selectedCollection) return;
    setUploading(true);
    setUploadError(null);
    try {
      await nocaiAPI.knowledge.uploadDocuments(selectedCollection.id, uploadFiles.map((file) => file.path));
      setShowUploadDialog(false);
      setUploadFiles([]);
      await handleSelectCollection(selectedCollection);
    } catch (error) {
      const message = userFacingError(error, 'Could not queue the selected documents.');
      console.error('Failed to upload:', message);
      setUploadError(message);
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
      setError(error instanceof Error ? error.message : 'Could not reprocess the document.');
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    try {
      const result = await nocaiAPI.knowledge.deleteDocument(docId);
      await handleSelectCollection(selectedCollection!);
      if (result.warning) setError(result.warning);
    } catch (error) {
      console.error('Failed to delete document:', error);
      setError(error instanceof Error ? error.message : 'Could not delete the document.');
    } finally {
      setShowDeleteDocConfirm(false);
      setDeletingDocId(null);
    }
  };

  const handleDeleteCollection = async (collectionId: string) => {
    try {
      const result = await nocaiAPI.knowledge.deleteCollection(collectionId);
      setCollections(prev => prev.filter(c => c.id !== collectionId));
      if (selectedCollection?.id === collectionId) {
        setSelectedCollection(null);
        setDocuments([]);
      }
      if (result.warning) setError(result.warning);
    } catch (error) {
      console.error('Failed to delete collection:', error);
      setError(error instanceof Error ? error.message : 'Could not delete the collection.');
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

      {error && (
        <div className="mb-4 flex items-start justify-between gap-3 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <div className="flex min-w-0 items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} className="flex-none font-medium hover:underline">Dismiss</button>
        </div>
      )}

      <div className="flex flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
        {/* Collections Sidebar */}
        <Card className="flex max-h-64 w-full flex-shrink-0 flex-col lg:h-full lg:max-h-none lg:w-80">
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
                  {(selectedCollection.permission === 'admin' || selectedCollection.ownerId === user?.id) && (
                    <Button
                      variant="destructive"
                      onClick={() => {
                        setDeletingCollectionId(selectedCollection.id);
                        setShowDeleteCollectionConfirm(true);
                      }}
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Delete Source
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => { setUploadError(null); setShowUploadDialog(true); }} disabled={!selectedCollection}>
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
                    <div className="h-full overflow-auto">
                      <table className="w-full min-w-[760px]">
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
                                {processingStatuses.includes(doc.status) && (
                                  <div className="mt-2 w-32">
                                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                                      <div
                                        className="h-full rounded-full bg-primary transition-[width]"
                                        style={{ width: `${Math.max(4, doc.ingestionProgress || 0)}%` }}
                                      />
                                    </div>
                                    <p className="mt-1 text-xs text-muted-foreground">
                                      {doc.ingestionStage || doc.status} {doc.ingestionProgress || 0}%
                                    </p>
                                  </div>
                                )}
                                {doc.errorMessage && (
                                  <p className="mt-1 max-w-xs text-xs text-destructive">{doc.errorMessage}</p>
                                )}
                              </td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{doc.pageCount || '-'}</td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{doc.chunkCount}</td>
                              <td className="px-4 py-3 text-sm text-muted-foreground">{formatFileSize(doc.sizeBytes)}</td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1">
                                  {doc.status === 'failed' && (
                                    <Button variant="ghost" size="sm" onClick={() => handleReprocess(doc.id)} aria-label={`Reprocess ${doc.originalFilename}`} title="Reprocess document">
                                      <RefreshCw className="w-4 h-4" />
                                    </Button>
                                  )}
                                  <Button variant="outline" size="sm" className="text-destructive" onClick={() => { setDeletingDocId(doc.id); setShowDeleteDocConfirm(true); }} aria-label={`Delete ${doc.originalFilename}`} title="Delete document">
                                    <Trash2 className="mr-1.5 w-4 h-4" />
                                    Delete
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
      <Dialog
        open={showUploadDialog}
        onOpenChange={(open) => {
          setShowUploadDialog(open);
          if (!open) setUploadError(null);
        }}
        title="Upload Documents"
        description="Queue local files for background indexing"
      >
        <div className="space-y-4">
          <button
            type="button"
            className="w-full rounded-lg border-2 border-dashed border-border p-8 text-center transition-colors hover:border-primary/50 hover:bg-accent/30"
            onClick={handleBrowseDocuments}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('border-primary'); }}
            onDragLeave={(e) => { e.currentTarget.classList.remove('border-primary'); }}
            onDrop={(e) => {
              e.preventDefault();
              e.currentTarget.classList.remove('border-primary');
              handleDroppedFiles(Array.from(e.dataTransfer.files));
            }}
          >
            <Upload className="w-12 h-12 text-muted-foreground/50 mx-auto mb-4" />
            <p className="text-foreground">Choose documents or drop them here</p>
            <p className="text-sm text-muted-foreground mt-1">TXT, Markdown, PDF, DOCX, CSV, and HTML. Up to 512 MB each.</p>
          </button>

          {uploadError && (
            <div className="flex items-start gap-2 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>{uploadError}</span>
            </div>
          )}

          {uploadFiles.length > 0 && (
            <div className="max-h-64 overflow-y-auto space-y-2">
              {uploadFiles.map((file) => (
                <div key={file.path} className="flex items-center justify-between gap-3 p-3 bg-muted/50 rounded-lg">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="w-5 h-5 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="font-medium truncate max-w-[200px]">{file.name}</p>
                      <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setUploadFiles(prev => prev.filter((item) => item.path !== file.path))} aria-label={`Remove ${file.name}`}>
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => { setShowUploadDialog(false); setUploadFiles([]); }}>Cancel</Button>
            <Button onClick={handleUpload} disabled={uploadFiles.length === 0 || uploading || !selectedCollection} isLoading={uploading}>
              {uploading
                ? 'Queueing...'
                : uploadFiles.length
                  ? `Queue ${uploadFiles.length} document${uploadFiles.length === 1 ? '' : 's'}`
                  : 'Queue documents'}
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
        title="Delete Knowledge Source"
        description={`Delete ${selectedCollection?.name || 'this source'}? Its documents, indexed chunks, citations, and stored source files will be permanently removed.`}
        confirmText="Delete Source"
        cancelText="Cancel"
        onConfirm={() => deletingCollectionId && handleDeleteCollection(deletingCollectionId)}
        variant="destructive"
      />
    </div>
  );
};
