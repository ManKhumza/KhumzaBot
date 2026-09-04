import React, { useState, useEffect } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Moon, Sun, Monitor, Cpu, Database, Shield, HardDrive, Key, Bell, Save, Loader2 } from 'lucide-react';
import { clsx } from 'clsx';
import type { Settings as SettingsType } from '@/types';

export const Settings = () => {
  const { user } = useAuthStore();
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<'appearance' | 'models' | 'knowledge' | 'storage' | 'security' | 'diagnostics'>('appearance');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordError, setPasswordError] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await nocaiAPI.settings.get();
      setSettings(data);
    } catch (error) {
      console.error('Failed to load settings:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await nocaiAPI.settings.update(settings);
      setSaving(false);
    } catch (error) {
      console.error('Failed to save settings:', error);
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword !== confirmPassword) {
      setPasswordError('Passwords do not match');
      return;
    }
    if (newPassword.length < 12) {
      setPasswordError('Password must be at least 12 characters');
      return;
    }
    try {
      await nocaiAPI.auth.changePassword({ currentPassword, newPassword });
      setShowPasswordDialog(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
    } catch (error: any) {
      setPasswordError(error.message || 'Failed to change password');
    }
  };

  const tabs = [
    { id: 'appearance', label: 'Appearance', icon: Monitor },
    { id: 'models', label: 'Models', icon: Cpu },
    { id: 'knowledge', label: 'Knowledge', icon: Database },
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'diagnostics', label: 'Diagnostics', icon: Bell },
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground">Configure your NOC AI Assistant preferences</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1" role="tablist">
            {tabs.map(tab => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={clsx(
                  'flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors',
                  activeTab === tab.id
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <tab.icon className="w-4 h-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === 'appearance' && (
            <AppearanceSettings settings={settings} onChange={setSettings} />
          )}
          {activeTab === 'models' && (
            <ModelsSettings settings={settings} onChange={setSettings} />
          )}
          {activeTab === 'knowledge' && (
            <KnowledgeSettings settings={settings} onChange={setSettings} />
          )}
          {activeTab === 'storage' && (
            <StorageSettings settings={settings} onChange={setSettings} />
          )}
          {activeTab === 'security' && (
            <SecuritySettings 
              settings={settings} 
              onChange={setSettings}
              onChangePassword={() => setShowPasswordDialog(true)}
            />
          )}
          {activeTab === 'diagnostics' && (
            <DiagnosticsSettings settings={settings} onChange={setSettings} />
          )}
        </CardContent>
        <CardFooter className="flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={loadSettings} disabled={saving}>
            Reset
          </Button>
          <Button onClick={handleSave} isLoading={saving}>
            <Save className="w-4 h-4 mr-2" />
            Save Changes
          </Button>
        </CardFooter>
      </Card>

      {/* Change Password Dialog */}
      <Dialog open={showPasswordDialog} onOpenChange={setShowPasswordDialog} title="Change Password">
        <div className="space-y-4">
          <Input
            label="Current Password"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Enter current password"
          />
          <Input
            label="New Password"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Enter new password (min 12 characters)"
          />
          <Input
            label="Confirm New Password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
          />
          {passwordError && (
            <div className="text-sm text-destructive">{passwordError}</div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowPasswordDialog(false)}>Cancel</Button>
            <Button onClick={handleChangePassword}>Change Password</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
};

const AppearanceSettings = ({ settings, onChange }: { settings: SettingsType | null; onChange: (s: SettingsType) => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <div>
        <label className="block text-sm font-medium mb-3">Theme</label>
        <div className="grid grid-cols-3 gap-3">
          {['light', 'dark', 'system'].map(theme => (
            <button
              key={theme}
              onClick={() => onChange({ ...settings, appearance: { ...settings.appearance, theme: theme as any } })}
              className={clsx(
                'p-4 rounded-lg border-2 transition-colors flex flex-col items-center gap-2',
                settings.appearance.theme === theme
                  ? 'border-primary bg-primary/5'
                  : 'border-border hover:border-primary/50'
              )}
            >
              {theme === 'light' && <Sun className="w-8 h-8" />}
              {theme === 'dark' && <Moon className="w-8 h-8" />}
              {theme === 'system' && <Monitor className="w-8 h-8" />}
              <span className="font-medium capitalize">{theme}</span>
            </button>
          ))}
        </div>
      </div>
      <div>
        <label className="block text-sm font-medium mb-2">Language</label>
        <select
          value={settings.appearance.language}
          onChange={(e) => onChange({ ...settings, appearance: { ...settings.appearance, language: e.target.value } })}
          className="w-full max-w-xs h-10 px-3 border border-input rounded-lg bg-background"
        >
          <option value="en">English</option>
        </select>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.appearance.sidebarCollapsed}
            onChange={(e) => onChange({ ...settings, appearance: { ...settings.appearance, sidebarCollapsed: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-sm">Collapse sidebar by default</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.appearance.compactMode}
            onChange={(e) => onChange({ ...settings, appearance: { ...settings.appearance, compactMode: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-sm">Compact mode</span>
        </label>
      </div>
    </div>
  );
};

const ModelsSettings = ({ settings, onChange }: { settings: SettingsType | null; onChange: (s: SettingsType) => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Default Models</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Default Chat Model ID"
          value={settings.models.defaultChatModelId || ''}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, defaultChatModelId: e.target.value || null } })}
          placeholder="Auto"
        />
        <Input
          label="Default Embedding Model ID"
          value={settings.models.defaultEmbeddingModelId || ''}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, defaultEmbeddingModelId: e.target.value || null } })}
          placeholder="Auto"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-2">Model Directory</label>
        <Input
          value={settings.models.modelDirectory}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, modelDirectory: e.target.value } })}
          placeholder="Default: %APPDATA%/NOC AI Assistant/models"
        />
      </div>
      <h3 className="text-lg font-medium mt-6">Default Inference Parameters</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <Input
          label="Context Length"
          type="number"
          value={settings.models.defaultContextLength}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, defaultContextLength: Number(e.target.value) } })}
        />
        <Input
          label="Threads (0 = auto)"
          type="number"
          value={settings.models.defaultThreads}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, defaultThreads: Number(e.target.value) } })}
        />
        <Input
          label="GPU Layers (-1 = auto)"
          type="number"
          value={settings.models.defaultGpuLayers}
          onChange={(e) => onChange({ ...settings, models: { ...settings.models, defaultGpuLayers: Number(e.target.value) } })}
        />
      </div>
    </div>
  );
};

const KnowledgeSettings = ({ settings, onChange }: { settings: SettingsType | null; onChange: (s: SettingsType) => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Default Chunking</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Chunk Size (tokens)"
          type="number"
          value={settings.knowledge.defaultChunkSize}
          onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultChunkSize: Number(e.target.value) } })}
        />
        <Input
          label="Chunk Overlap (tokens)"
          type="number"
          value={settings.knowledge.defaultChunkOverlap}
          onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultChunkOverlap: Number(e.target.value) } })}
        />
      </div>
      <h3 className="text-lg font-medium">Retrieval</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <Input
          label="Top K Results"
          type="number"
          value={settings.knowledge.defaultTopK}
          onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultTopK: Number(e.target.value) } })}
        />
        <Input
          label="Hybrid Alpha (0-1)"
          type="number"
          step="0.1"
          min="0"
          max="1"
          value={settings.knowledge.hybridAlpha}
          onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, hybridAlpha: Number(e.target.value) } })}
        />
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.knowledge.enableReranking}
            onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, enableReranking: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-sm">Enable reranking</span>
        </label>
        <Input
          label="Reranker Model ID"
          value={settings.knowledge.rerankerModelId || ''}
          onChange={(e) => onChange({ ...settings, knowledge: { ...settings.knowledge, rerankerModelId: e.target.value || null } })}
          placeholder="Optional"
          disabled={!settings.knowledge.enableReranking}
        />
      </div>
    </div>
  );
};

const StorageSettings = ({ settings, onChange }: { settings: SettingsType | null; onChange: (s: SettingsType) => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Data Locations</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <Input
          label="Data Location"
          value={settings.storage.dataLocation}
          onChange={(e) => onChange({ ...settings, storage: { ...settings.storage, dataLocation: e.target.value } })}
          placeholder="Default: %APPDATA%/NOC AI Assistant"
        />
        <Input
          label="Model Storage"
          value={settings.storage.modelStorage}
          onChange={(e) => onChange({ ...settings, storage: { ...settings.storage, modelStorage: e.target.value } })}
          placeholder="Default: %APPDATA%/NOC AI Assistant/models"
        />
        <Input
          label="Knowledge Storage"
          value={settings.storage.knowledgeStorage}
          onChange={(e) => onChange({ ...settings, storage: { ...settings.storage, knowledgeStorage: e.target.value } })}
          placeholder="Default: %APPDATA%/NOC AI Assistant/knowledge"
        />
      </div>
      <div className="p-4 rounded-lg bg-muted/50 text-sm text-muted-foreground">
        <p className="font-medium mb-2">Current Usage</p>
        <p>Run a backup to see storage usage statistics.</p>
      </div>
    </div>
  );
};

const SecuritySettings = ({ settings, onChange, onChangePassword }: { settings: SettingsType | null; onChange: (s: SettingsType) => void; onChangePassword: () => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Session & Authentication</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <Input
          label="Session Timeout (minutes)"
          type="number"
          value={settings.security.sessionTimeoutMinutes}
          onChange={(e) => onChange({ ...settings, security: { ...settings.security, sessionTimeoutMinutes: Number(e.target.value) } })}
        />
        <Input
          label="Max Failed Logins"
          type="number"
          value={settings.security.maxFailedLogins}
          onChange={(e) => onChange({ ...settings, security: { ...settings.security, maxFailedLogins: Number(e.target.value) } })}
        />
        <Input
          label="Lockout Duration (minutes)"
          type="number"
          value={settings.security.lockoutDurationMinutes}
          onChange={(e) => onChange({ ...settings, security: { ...settings.security, lockoutDurationMinutes: Number(e.target.value) } })}
        />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Input
          label="Min Password Length"
          type="number"
          value={settings.security.passwordMinLength}
          onChange={(e) => onChange({ ...settings, security: { ...settings.security, passwordMinLength: Number(e.target.value) } })}
        />
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={settings.security.requireSpecialChars}
            onChange={(e) => onChange({ ...settings, security: { ...settings.security, requireSpecialChars: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
            id="require-special"
          />
          <label htmlFor="require-special" className="text-sm">Require special characters</label>
        </div>
      </div>
      <div className="pt-4 border-t border-border">
        <Button variant="outline" onClick={onChangePassword}>
          <Key className="w-4 h-4 mr-2" />
          Change Password
        </Button>
      </div>
    </div>
  );
};

const DiagnosticsSettings = ({ settings, onChange }: { settings: SettingsType | null; onChange: (s: SettingsType) => void }) => {
  if (!settings) return null;
  return (
    <div className="space-y-6">
      <h3 className="text-lg font-medium">Logging & Telemetry</h3>
      <div>
        <label className="block text-sm font-medium mb-2">Log Level</label>
        <select
          value={settings.diagnostics.logLevel}
          onChange={(e) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, logLevel: e.target.value as SettingsType['diagnostics']['logLevel'] } })}
          className="w-full max-w-xs h-10 px-3 border border-input rounded-lg bg-background"
        >
          <option value="debug">Debug</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
        </select>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.diagnostics.enableTelemetry}
            onChange={(e) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, enableTelemetry: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
            disabled
          />
          <span className="text-sm text-muted-foreground">Enable telemetry (disabled in offline mode)</span>
        </label>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.diagnostics.autoCheckUpdates}
            onChange={(e) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, autoCheckUpdates: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
            disabled
          />
          <span className="text-sm text-muted-foreground">Auto-check for updates (disabled in offline mode)</span>
        </label>
      </div>
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={settings.diagnostics.debugMode}
            onChange={(e) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, debugMode: e.target.checked } })}
            className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
          />
          <span className="text-sm">Debug mode</span>
        </label>
      </div>
      <div className="pt-4 border-t border-border">
        <p className="text-sm text-muted-foreground mb-4">Logs are stored in %LOCALAPPDATA%/NOC AI Assistant/logs/</p>
      </div>
    </div>
  );
};
