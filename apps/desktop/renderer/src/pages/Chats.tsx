import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { nocaiAPI } from '@/utils/api';
import { relativeTime } from '@/utils/date';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { AlertDialog, Dialog } from '@/components/common/Dialog';
import { Edit2, Loader2, MessageSquare, Plus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { Conversation } from '@/types';

export const Chats = () => {
  const navigate = useNavigate();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewChatDialog, setShowNewChatDialog] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingConversation, setDeletingConversation] = useState<Conversation | null>(null);
  const [renamingConversation, setRenamingConversation] = useState<Conversation | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [renaming, setRenaming] = useState(false);

  const loadConversations = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setConversations(await nocaiAPI.chat.getConversations());
    } catch (loadFailure) {
      setError(loadFailure instanceof Error ? loadFailure.message : 'Could not load conversations.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleCreateChat = async () => {
    setCreating(true);
    setError(null);
    try {
      const conversation = await nocaiAPI.chat.createConversation(newChatTitle.trim() || undefined);
      setShowNewChatDialog(false);
      setNewChatTitle('');
      navigate(`/chats/${conversation.id}`);
    } catch (createFailure) {
      setError(createFailure instanceof Error ? createFailure.message : 'Could not create a conversation.');
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteChat = async () => {
    if (!deletingConversation) return;
    try {
      await nocaiAPI.chat.deleteConversation(deletingConversation.id);
      setConversations((current) => current.filter((conversation) => conversation.id !== deletingConversation.id));
    } catch (deleteFailure) {
      setError(deleteFailure instanceof Error ? deleteFailure.message : 'Could not delete the conversation.');
    } finally {
      setDeletingConversation(null);
    }
  };

  const openRenameDialog = (conversation: Conversation) => {
    setRenamingConversation(conversation);
    setRenameTitle(conversation.title);
  };

  const handleRenameChat = async (event: React.FormEvent) => {
    event.preventDefault();
    const title = renameTitle.trim();
    if (!renamingConversation || !title) return;
    setRenaming(true);
    try {
      const updated = await nocaiAPI.chat.updateConversation(renamingConversation.id, { title });
      setConversations((current) => current.map((conversation) =>
        conversation.id === updated.id ? updated : conversation
      ));
      setRenamingConversation(null);
      setRenameTitle('');
    } catch (renameFailure) {
      setError(renameFailure instanceof Error ? renameFailure.message : 'Could not rename the conversation.');
    } finally {
      setRenaming(false);
    }
  };

  const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
  const filteredConversations = conversations.filter((conversation) =>
    conversation.title.toLocaleLowerCase().includes(normalizedQuery)
  );

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h2 className="text-2xl font-semibold">Conversations</h2>
          <p className="mt-1 text-sm text-muted-foreground">Recent local chat history</p>
        </div>
        <Button onClick={() => setShowNewChatDialog(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New chat
        </Button>
      </div>

      {error && (
        <div className="flex items-start justify-between gap-3 border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive" role="alert">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="rounded p-0.5 hover:bg-destructive/10" aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Search conversations"
          placeholder="Search conversations"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          className="pl-9"
        />
      </div>

      <section className="border-y border-border" aria-label="Conversation list">
        {loading ? (
          <div className="flex h-56 items-center justify-center">
            <Loader2 className="h-7 w-7 animate-spin text-primary" aria-label="Loading conversations" />
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
            <MessageSquare className="h-9 w-9 text-muted-foreground/60" />
            <h3 className="mt-4 text-base font-semibold">
              {normalizedQuery ? 'No matching conversations' : 'No conversations yet'}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {normalizedQuery ? 'Try a different search.' : 'Your first conversation will appear here.'}
            </p>
            {!normalizedQuery && (
              <Button className="mt-5" onClick={() => setShowNewChatDialog(true)}>
                <Plus className="mr-2 h-4 w-4" />
                New chat
              </Button>
            )}
            {error && (
              <Button variant="ghost" className="mt-3" onClick={loadConversations}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Retry
              </Button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-border">
            {filteredConversations.map((conversation) => (
              <div key={conversation.id} className="group flex items-center gap-2 py-1 pr-2 hover:bg-accent/50">
                <button
                  onClick={() => navigate(`/chats/${conversation.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
                >
                  <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <MessageSquare className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{conversation.title}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Updated {relativeTime(conversation.updatedAt)}</p>
                  </div>
                </button>
                <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => openRenameDialog(conversation)}
                    title="Rename conversation"
                    aria-label={`Rename ${conversation.title}`}
                  >
                    <Edit2 className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                    onClick={() => setDeletingConversation(conversation)}
                    title="Delete conversation"
                    aria-label={`Delete ${conversation.title}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <Dialog
        open={showNewChatDialog}
        onOpenChange={setShowNewChatDialog}
        title="New conversation"
        description="Add a title now, or leave it blank and start immediately."
      >
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            handleCreateChat();
          }}
        >
          <Input
            label="Title"
            value={newChatTitle}
            onChange={(event) => setNewChatTitle(event.target.value)}
            placeholder="New chat"
            maxLength={200}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setShowNewChatDialog(false)}>Cancel</Button>
            <Button type="submit" isLoading={creating}>Create</Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(renamingConversation)}
        onOpenChange={(open) => {
          if (!open) setRenamingConversation(null);
        }}
        title="Rename conversation"
      >
        <form onSubmit={handleRenameChat} className="space-y-4">
          <Input
            label="Title"
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            maxLength={200}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setRenamingConversation(null)}>Cancel</Button>
            <Button type="submit" isLoading={renaming} disabled={!renameTitle.trim()}>Save</Button>
          </div>
        </form>
      </Dialog>

      <AlertDialog
        open={Boolean(deletingConversation)}
        onOpenChange={(open) => {
          if (!open) setDeletingConversation(null);
        }}
        title="Delete conversation"
        description={deletingConversation ? `Delete "${deletingConversation.title}" and its messages? This cannot be undone.` : undefined}
        confirmText="Delete"
        onConfirm={handleDeleteChat}
        variant="destructive"
      />
    </div>
  );
};
