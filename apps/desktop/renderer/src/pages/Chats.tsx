import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Plus, Trash2, Edit2, MessageSquare, Loader2, Search } from 'lucide-react';
import { clsx } from 'clsx';
import type { Conversation } from '@/types';

export const Chats = () => {
  const navigate = useNavigate();
  const params = useParams();
  const { isAuthenticated } = useAuthStore();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showNewChatDialog, setShowNewChatDialog] = useState(false);
  const [newChatTitle, setNewChatTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  useEffect(() => {
    loadConversations();
  }, []);

  const loadConversations = async () => {
    try {
      const data = await nocaiAPI.chat.getConversations();
      setConversations(data);
    } catch (error) {
      console.error('Failed to load conversations:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateChat = async () => {
    if (!newChatTitle.trim()) return;
    setCreating(true);
    try {
      const conversation = await nocaiAPI.chat.createConversation(newChatTitle.trim());
      navigate(`/chats/${conversation.id}`);
      setShowNewChatDialog(false);
      setNewChatTitle('');
    } catch (error) {
      console.error('Failed to create chat:', error);
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteChat = async (id: string) => {
    try {
      await nocaiAPI.chat.deleteConversation(id);
      setConversations(prev => prev.filter(c => c.id !== id));
    } catch (error) {
      console.error('Failed to delete chat:', error);
    } finally {
      setShowDeleteConfirm(false);
      setDeletingId(null);
    }
  };

  const handleRenameChat = async (id: string, title: string) => {
    try {
      await nocaiAPI.chat.renameConversation(id, title);
      setConversations(prev => prev.map(c => c.id === id ? { ...c, title } : c));
    } catch (error) {
      console.error('Failed to rename chat:', error);
    }
  };

  const filteredConversations = conversations.filter(c =>
    c.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // If we have a conversationId in params, navigate to it
  if (params.conversationId && params.conversationId !== 'new') {
    return null; // Will be handled by ChatView route
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Chats</h1>
          <p className="text-muted-foreground">Your conversation history</p>
        </div>
        <Button onClick={() => setShowNewChatDialog(true)}>
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
      </div>

      {/* Search */}
      <div className="mb-4">
        <Input
          placeholder="Search conversations..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="max-w-md"
        />
      </div>

      {/* Conversation List */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center h-64">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          ) : filteredConversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center px-8">
              <MessageSquare className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-1">
                {searchQuery ? 'No conversations found' : 'No conversations yet'}
              </h3>
              <p className="text-muted-foreground mb-4">
                {searchQuery ? 'Try adjusting your search' : 'Start a new chat to begin'}
              </p>
              {!searchQuery && (
                <Button onClick={() => setShowNewChatDialog(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  New Chat
                </Button>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filteredConversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  to={`/chats/${conversation.id}`}
                  className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="font-medium text-foreground truncate">{conversation.title}</p>
                    <p className="text-sm text-muted-foreground truncate">
                      {new Date(conversation.updatedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        const newTitle = prompt('Rename conversation:', conversation.title);
                        if (newTitle) handleRenameChat(conversation.id, newTitle);
                      }}
                      className="group"
                    >
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={(e) => {
                        e.preventDefault();
                        setDeletingId(conversation.id);
                        setShowDeleteConfirm(true);
                      }}
                      className="group text-destructive hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* New Chat Dialog */}
      <Dialog open={showNewChatDialog} onOpenChange={setShowNewChatDialog} title="New Chat">
        <div className="space-y-4">
          <Input
            label="Title (optional)"
            value={newChatTitle}
            onChange={(e) => setNewChatTitle(e.target.value)}
            placeholder="Enter conversation title"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowNewChatDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateChat} isLoading={creating}>
              {creating ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={showDeleteConfirm}
        onOpenChange={setShowDeleteConfirm}
        title="Delete Conversation"
        description="Are you sure you want to delete this conversation? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => deletingId && handleDeleteChat(deletingId)}
        variant="destructive"
      />
    </div>
  );
};
