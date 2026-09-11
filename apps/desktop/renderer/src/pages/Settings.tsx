import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, Bell, Bot, Cpu, Database, HardDrive, Key, Loader2, Monitor, Moon, RefreshCw, Save, Shield, Sun } from 'lucide-react';
import { clsx } from 'clsx';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Textarea } from '@/components/common/Textarea';
import { Card, CardContent, CardFooter, CardHeader } from '@/components/common/Card';
import { Dialog } from '@/components/common/Dialog';
import { userFacingError } from '@/utils/errors';
import type { Settings as SettingsType } from '@/types';

type SettingsTab = 'appearance' | 'models' | 'knowledge' | 'behavior' | 'storage' | 'security' | 'diagnostics';
type PanelProps = { settings: SettingsType; onChange: (settings: SettingsType) => void };
const selectClass = 'h-10 w-full rounded-lg border border-input bg-background px-3';

export const Settings = () => {
  const { user, changePassword } = useAuthStore();
  const location = useLocation();
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>('appearance');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPasswordDialog, setShowPasswordDialog] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const passwordChangeRequired = Boolean(user?.mustChangePassword);
  const isAdministrator = Boolean(user?.roles.includes('administrator'));

  const loadSettings = async () => {
    setLoading(true);
    setSettingsError(null);
    try {
      setSettings(await nocaiAPI.settings.get());
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Could not load settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (!passwordChangeRequired) void loadSettings(); }, [passwordChangeRequired]);
  useEffect(() => {
    if (passwordChangeRequired || new URLSearchParams(location.search).get('password') === 'required') {
      setActiveTab('security');
      setShowPasswordDialog(true);
    }
  }, [location.search, passwordChangeRequired]);

  const saveSettings = async () => {
    if (!settings) return;
    setSaving(true);
    setSettingsError(null);
    try {
      setSettings(await nocaiAPI.settings.update(settings));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : 'Could not save settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleChangePassword = async () => {
    if (changingPassword) return;
    if (newPassword !== confirmPassword) return setPasswordError('Passwords do not match');
    if (newPassword.length < 12) return setPasswordError('Password must be at least 12 characters');
    setChangingPassword(true);
    setPasswordError('');
    try {
      await changePassword(currentPassword, newPassword);
      setShowPasswordDialog(false);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordError('');
      navigate('/settings', { replace: true });
    } catch (error) {
      setPasswordError(userFacingError(error, 'Failed to change password'));
    } finally { setChangingPassword(false); }
  };

  const tabs = [
    { id: 'appearance', label: 'Appearance', icon: Monitor },
    { id: 'models', label: 'Models', icon: Cpu },
    { id: 'knowledge', label: 'Knowledge', icon: Database },
    ...(isAdministrator ? [{ id: 'behavior', label: 'Behavior', icon: Bot }] : []),
    { id: 'storage', label: 'Storage', icon: HardDrive },
    { id: 'security', label: 'Security', icon: Shield },
    { id: 'diagnostics', label: 'Diagnostics', icon: Bell },
  ] as const;

  const passwordForm = <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void handleChangePassword(); }}>
    <Input label="Current Password" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required disabled={changingPassword} />
    <Input label="New Password" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required disabled={changingPassword} />
    <Input label="Confirm New Password" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required disabled={changingPassword} />
    {passwordError && <div role="alert" className="text-sm text-destructive">{passwordError}</div>}
    <div className="flex justify-end gap-2">{!passwordChangeRequired && <Button type="button" variant="outline" onClick={() => setShowPasswordDialog(false)} disabled={changingPassword}>Cancel</Button>}<Button type="submit" isLoading={changingPassword}>Change Password</Button></div>
  </form>;

  if (passwordChangeRequired) return <Card className="mx-auto max-w-lg"><CardHeader><h2 className="text-xl font-semibold">Set a new password</h2><p className="text-sm text-muted-foreground">Your administrator requires a password change before you continue.</p></CardHeader><CardContent>{passwordForm}</CardContent></Card>;

  if (loading) return <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>;
  if (!settings) return (
    <div className="flex min-h-64 items-center justify-center p-6">
      <div className="w-full max-w-md border border-border bg-card p-6 text-center">
        <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
        <h1 className="mt-3 text-lg font-semibold">Settings are temporarily unavailable</h1>
        <p className="mt-2 text-sm text-muted-foreground">{settingsError || 'The local settings service did not return data.'}</p>
        <Button className="mt-4" onClick={() => void loadSettings()}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold">Settings</h1><p className="text-muted-foreground">Configure your NOC AI Assistant preferences</p></div>
      {settingsError && <div className="flex gap-2 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert"><AlertTriangle className="h-4 w-4 flex-none" />{settingsError}</div>}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1" role="tablist">
            {tabs.map((tab) => <button key={tab.id} role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id as SettingsTab)} className={clsx('flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium', activeTab === tab.id ? 'bg-background shadow-sm' : 'text-muted-foreground hover:text-foreground')}><tab.icon className="h-4 w-4" />{tab.label}</button>)}
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === 'appearance' && <AppearancePanel settings={settings} onChange={setSettings} />}
          {activeTab === 'models' && <ModelsPanel settings={settings} onChange={setSettings} />}
          {activeTab === 'knowledge' && <KnowledgePanel settings={settings} onChange={setSettings} />}
          {activeTab === 'behavior' && isAdministrator && <BehaviorPanel settings={settings} onChange={setSettings} />}
          {activeTab === 'storage' && <><StoragePanel settings={settings} onChange={setSettings} />{isAdministrator && <BackupPanel />}</>}
          {activeTab === 'security' && <SecurityPanel settings={settings} onChange={setSettings} onChangePassword={() => setShowPasswordDialog(true)} />}
          {activeTab === 'diagnostics' && <DiagnosticsPanel settings={settings} onChange={setSettings} />}
        </CardContent>
        <CardFooter className="flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" onClick={() => void loadSettings()} disabled={saving}>Reset</Button>
          <Button onClick={() => void saveSettings()} isLoading={saving}><Save className="mr-2 h-4 w-4" />Save Changes</Button>
        </CardFooter>
      </Card>
      <Dialog open={showPasswordDialog} onOpenChange={(open) => { if (!open && passwordChangeRequired) return; setShowPasswordDialog(open); }} title={passwordChangeRequired ? 'Set a new password' : 'Change Password'} description={passwordChangeRequired ? 'Your administrator requires a password change before you continue.' : undefined}>
        {passwordForm}
      </Dialog>
    </div>
  );
};

const AppearancePanel = ({ settings, onChange }: PanelProps) => <div className="space-y-6">
  <div><label className="mb-3 block text-sm font-medium">Theme</label><div className="grid grid-cols-3 gap-3">{(['light', 'dark', 'system'] as const).map((theme) => <button key={theme} onClick={() => onChange({ ...settings, appearance: { ...settings.appearance, theme } })} className={clsx('flex flex-col items-center gap-2 rounded-lg border-2 p-4', settings.appearance.theme === theme ? 'border-primary bg-primary/5' : 'border-border')}>{theme === 'light' ? <Sun /> : theme === 'dark' ? <Moon /> : <Monitor />}<span className="capitalize">{theme}</span></button>)}</div></div>
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.appearance.sidebarCollapsed} onChange={(event) => onChange({ ...settings, appearance: { ...settings.appearance, sidebarCollapsed: event.target.checked } })} />Collapse sidebar by default</label>
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.appearance.compactMode} onChange={(event) => onChange({ ...settings, appearance: { ...settings.appearance, compactMode: event.target.checked } })} />Compact mode</label>
</div>;

const ModelsPanel = ({ settings, onChange }: PanelProps) => <div className="grid gap-4 md:grid-cols-2">
  <Input label="Default Chat Model ID" value={settings.models.defaultChatModelId || ''} onChange={(event) => onChange({ ...settings, models: { ...settings.models, defaultChatModelId: event.target.value || null } })} placeholder="Auto" />
  <Input label="Default Embedding Model ID" value={settings.models.defaultEmbeddingModelId || ''} onChange={(event) => onChange({ ...settings, models: { ...settings.models, defaultEmbeddingModelId: event.target.value || null } })} placeholder="Auto" />
  <Input label="Context Length" type="number" value={settings.models.defaultContextLength} onChange={(event) => onChange({ ...settings, models: { ...settings.models, defaultContextLength: Number(event.target.value) } })} />
  <Input label="Threads (0 = auto)" type="number" value={settings.models.defaultThreads} onChange={(event) => onChange({ ...settings, models: { ...settings.models, defaultThreads: Number(event.target.value) } })} />
  <Input label="GPU Layers (-1 = auto)" type="number" value={settings.models.defaultGpuLayers} onChange={(event) => onChange({ ...settings, models: { ...settings.models, defaultGpuLayers: Number(event.target.value) } })} />
  <Input label="Model Directory" value={settings.models.modelDirectory} onChange={(event) => onChange({ ...settings, models: { ...settings.models, modelDirectory: event.target.value } })} />
</div>;

const KnowledgePanel = ({ settings, onChange }: PanelProps) => <div className="grid gap-4 md:grid-cols-2">
  <Input label="Chunk Size" type="number" value={settings.knowledge.defaultChunkSize} onChange={(event) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultChunkSize: Number(event.target.value) } })} />
  <Input label="Chunk Overlap" type="number" value={settings.knowledge.defaultChunkOverlap} onChange={(event) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultChunkOverlap: Number(event.target.value) } })} />
  <Input label="Top K Results" type="number" value={settings.knowledge.defaultTopK} onChange={(event) => onChange({ ...settings, knowledge: { ...settings.knowledge, defaultTopK: Number(event.target.value) } })} />
  <Input label="Hybrid Alpha" type="number" min="0" max="1" step="0.1" value={settings.knowledge.hybridAlpha} onChange={(event) => onChange({ ...settings, knowledge: { ...settings.knowledge, hybridAlpha: Number(event.target.value) } })} />
</div>;

const BehaviorPanel = ({ settings, onChange }: PanelProps) => <div className="space-y-6">
  <div className="border border-primary/20 bg-primary/5 p-4"><h3 className="font-semibold">Chatbot behavior</h3><p className="mt-1 text-sm text-muted-foreground">Administrators control how answers are written, where they may come from, and how evidence is cited.</p></div>
  <div><label className="mb-2 block text-sm font-medium">System instructions</label><Textarea rows={8} value={settings.behavior.systemInstructions} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, systemInstructions: event.target.value } })} placeholder="Describe the chatbot's role, tone, boundaries, and answer format." /></div>
  <div className="grid gap-4 md:grid-cols-2">
    <label className="text-sm font-medium">Where answers may come from<select className={`${selectClass} mt-2`} value={settings.behavior.responseMode} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, responseMode: event.target.value as SettingsType['behavior']['responseMode'] } })}><option value="knowledge_only">Knowledge bank only</option><option value="knowledge_preferred">Prefer knowledge, allow model knowledge</option><option value="model_only">Model knowledge only</option></select></label>
    <label className="text-sm font-medium">Knowledge scope<select className={`${selectClass} mt-2`} value={settings.behavior.knowledgeScope} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, knowledgeScope: event.target.value as SettingsType['behavior']['knowledgeScope'] } })}><option value="selected_collection">Selected source</option><option value="all_collections">All knowledge sources</option></select></label>
    <label className="text-sm font-medium">Citation format<select className={`${selectClass} mt-2`} value={settings.behavior.citationStyle} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, citationStyle: event.target.value as SettingsType['behavior']['citationStyle'] } })}><option value="inline">Inline citations</option><option value="sources_list">Sources list</option><option value="inline_and_sources">Inline and sources list</option></select></label>
    <Input label="Maximum sources" type="number" min="1" max="20" value={settings.behavior.maxSources} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, maxSources: Number(event.target.value) } })} />
    <Input label="Minimum relevance score" type="number" min="0" max="1" step="0.05" value={settings.behavior.minimumRelevanceScore} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, minimumRelevanceScore: Number(event.target.value) } })} />
  </div>
  <div><label className="mb-2 block text-sm font-medium">Response when knowledge is unavailable</label><Textarea rows={3} value={settings.behavior.noKnowledgeResponse} onChange={(event) => onChange({ ...settings, behavior: { ...settings.behavior, noKnowledgeResponse: event.target.value } })} /></div>
</div>;

const StoragePanel = ({ settings, onChange }: PanelProps) => <div className="grid gap-4">
  <Input label="Data Location" value={settings.storage.dataLocation} onChange={(event) => onChange({ ...settings, storage: { ...settings.storage, dataLocation: event.target.value } })} />
  <Input label="Model Storage" value={settings.storage.modelStorage} onChange={(event) => onChange({ ...settings, storage: { ...settings.storage, modelStorage: event.target.value } })} />
  <Input label="Knowledge Storage" value={settings.storage.knowledgeStorage} onChange={(event) => onChange({ ...settings, storage: { ...settings.storage, knowledgeStorage: event.target.value } })} />
</div>;

const SecurityPanel = ({ settings, onChange, onChangePassword }: PanelProps & { onChangePassword: () => void }) => <div className="space-y-6">
  <div className="grid gap-4 md:grid-cols-3">
    <Input label="Session Timeout (minutes)" type="number" value={settings.security.sessionTimeoutMinutes} onChange={(event) => onChange({ ...settings, security: { ...settings.security, sessionTimeoutMinutes: Number(event.target.value) } })} />
    <Input label="Max Failed Logins" type="number" value={settings.security.maxFailedLogins} onChange={(event) => onChange({ ...settings, security: { ...settings.security, maxFailedLogins: Number(event.target.value) } })} />
    <Input label="Lockout Duration (minutes)" type="number" value={settings.security.lockoutDurationMinutes} onChange={(event) => onChange({ ...settings, security: { ...settings.security, lockoutDurationMinutes: Number(event.target.value) } })} />
  </div><Button variant="outline" onClick={onChangePassword}><Key className="mr-2 h-4 w-4" />Change Password</Button>
</div>;

const DiagnosticsPanel = ({ settings, onChange }: PanelProps) => <div className="space-y-4">
  <label className="block text-sm font-medium">Log Level<select className={`${selectClass} mt-2 max-w-xs`} value={settings.diagnostics.logLevel} onChange={(event) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, logLevel: event.target.value as SettingsType['diagnostics']['logLevel'] } })}><option value="debug">Debug</option><option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option></select></label>
  <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.diagnostics.debugMode} onChange={(event) => onChange({ ...settings, diagnostics: { ...settings.diagnostics, debugMode: event.target.checked } })} />Debug mode</label>
  <p className="text-sm text-muted-foreground">Logs are stored locally under the application data directory.</p>
  <a href="#/diagnostics" className="text-sm text-primary underline">Open local diagnostics and export</a>
</div>;

const BackupPanel = () => {
  const [busy, setBusy] = useState(false);
  const [includeModels, setIncludeModels] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const backup = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const destination = await window.nocai.dialog.saveFile({ title: 'Create backup', defaultPath: 'NOC-AI-Assistant-backup.zip', filters: [{ name: 'Backup archive', extensions: ['zip'] }] });
      if (!destination) return;
      await nocaiAPI.system.createBackup({ destination, includeModels, includeKnowledge: true });
      setNotice('Backup created in the location you selected. Keep it secure; it contains your application data.');
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusy(false); }
  };
  const selectRestore = async () => {
    setError(null);
    try {
      const paths = await window.nocai.dialog.openFiles({ title: 'Select backup to restore', filters: [{ name: 'Backup archive', extensions: ['zip'] }] });
      if (paths[0]) { setConfirmed(false); setRestorePath(paths[0]); }
    } catch (failure) { setError(userFacingError(failure)); }
  };
  const restore = async () => {
    if (!restorePath || !confirmed || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const result = await nocaiAPI.system.restoreBackup(restorePath);
      if (!result.success) throw new Error('Restore was not completed. Your current data has not been replaced.');
      if (result.restartRequired) await nocaiAPI.system.restartBackend();
      await useAuthStore.getState().logout();
      navigate('/login', { replace: true });
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusy(false); }
  };

  return <section className="mt-6 space-y-4 border-t border-border pt-6">
    <h3 className="font-semibold">Backup and restore</h3>
    <p className="text-sm text-muted-foreground">Back up chats, accounts, settings, and knowledge documents. Restore requires the same Windows account and restarts local services; a rollback snapshot is retained.</p>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={includeModels} onChange={(event) => setIncludeModels(event.target.checked)} disabled={busy} />Include model files (archives can be large)</label>
    <div className="flex gap-2"><Button variant="outline" onClick={() => void backup()} disabled={busy}>Create backup</Button><Button variant="outline" onClick={() => void selectRestore()} disabled={busy}>Restore backup</Button></div>
    {notice && <p role="status" className="text-sm">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Dialog open={restorePath !== null} onOpenChange={(open) => { if (!open && !busy) setRestorePath(null); }} title="Restore application backup" description="Restoring replaces the current local application data and signs everyone out. Keep a backup of your current work before continuing.">
      <p className="mt-4 break-all text-sm">Selected archive: {restorePath?.split(/[\\/]/).pop()}</p>
      <label className="my-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={busy} />I understand that this replaces the current application data.</label>
      {error && <p role="alert" className="mb-4 text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setRestorePath(null)} disabled={busy}>Cancel</Button><Button variant="destructive" onClick={() => void restore()} disabled={!confirmed || busy} isLoading={busy}>Restore and restart</Button></div>
    </Dialog>
  </section>;
};
