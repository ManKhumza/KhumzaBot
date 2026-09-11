import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { nocaiAPI } from '@/utils/api';
import { parseApiTimestamp } from '@/utils/date';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Dialog, AlertDialog } from '@/components/common/Dialog';
import { Plus, Trash2, Users, Shield, Activity, HardDrive, Monitor, Loader2, Search, Edit2, Key } from 'lucide-react';
import { clsx } from 'clsx';
import type { User, Role, AuditEntry, HealthStatus, JobProgress } from '@/types';
import { userFacingError } from '@/utils/errors';

type AdminTab = 'users' | 'roles' | 'audit' | 'jobs' | 'health';

const adminTabFromPath = (pathname: string): AdminTab => {
  const candidate = pathname.split('/')[2];
  return ['users', 'roles', 'audit', 'jobs', 'health'].includes(candidate)
    ? candidate as AdminTab
    : 'users';
};

export const Admin = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<AdminTab>(() => adminTabFromPath(location.pathname));
  const [error, setError] = useState<string | null>(null);
  
  // Users
  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [showCreateUserDialog, setShowCreateUserDialog] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [newUser, setNewUser] = useState({ username: '', password: '', displayName: '', email: '', roles: ['operator'] as string[] });
  const [creatingUser, setCreatingUser] = useState(false);
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null);
  const [showDeleteUserConfirm, setShowDeleteUserConfirm] = useState(false);

  // Roles
  const [roles, setRoles] = useState<Role[]>([]);
  const [rolesLoading, setRolesLoading] = useState(false);

  // Audit
  const [auditLogs, setAuditLogs] = useState<AuditEntry[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditFilters, setAuditFilters] = useState({ actorId: '', action: '', resourceType: '', limit: 100 });

  // Jobs
  const [jobs, setJobs] = useState<JobProgress[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsFilters, setJobsFilters] = useState<{ status: string; priority?: number }>({ status: '' });

  // Health
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const loadUsers = async () => {
    setUsersLoading(true);
    try {
      const data = await nocaiAPI.admin.listUsers();
      setUsers(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load users.'));
    } finally {
      setUsersLoading(false);
    }
  };

  const loadRoles = async () => {
    setRolesLoading(true);
    try {
      const data = await nocaiAPI.admin.listRoles();
      setRoles(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load roles.'));
    } finally {
      setRolesLoading(false);
    }
  };

  const loadAudit = async () => {
    setAuditLoading(true);
    try {
      const data = await nocaiAPI.admin.getAuditLog(auditFilters);
      setAuditLogs(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load audit events.'));
    } finally {
      setAuditLoading(false);
    }
  };

  const loadJobs = async () => {
    setJobsLoading(true);
    try {
      const data = await nocaiAPI.admin.getJobs(jobsFilters);
      setJobs(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load ingestion jobs.'));
    } finally {
      setJobsLoading(false);
    }
  };

  const loadHealth = async () => {
    setHealthLoading(true);
    try {
      const data = await nocaiAPI.admin.getHealth();
      setHealth(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load component health.'));
    } finally {
      setHealthLoading(false);
    }
  };

  useEffect(() => {
    setActiveTab(adminTabFromPath(location.pathname));
  }, [location.pathname]);

  useEffect(() => {
    if (activeTab === 'users') loadUsers();
    if (activeTab === 'roles') loadRoles();
    if (activeTab === 'audit') loadAudit();
    if (activeTab === 'jobs') loadJobs();
    if (activeTab === 'health') loadHealth();
  }, [activeTab]);

  const handleCreateUser = async () => {
    if (!newUser.username || !newUser.password) return;
    setCreatingUser(true);
    try {
      await nocaiAPI.admin.createUser(newUser);
      setShowCreateUserDialog(false);
      setNewUser({ username: '', password: '', displayName: '', email: '', roles: ['operator'] });
      await loadUsers();
    } catch (error) {
      setError(userFacingError(error, 'Could not create the user.'));
    } finally {
      setCreatingUser(false);
    }
  };

  const handleUpdateUser = async () => {
    if (!editingUser) return;
    try {
      await nocaiAPI.admin.updateUser(editingUser.id, {
        displayName: editingUser.displayName ?? undefined,
        email: editingUser.email ?? undefined,
        roles: editingUser.roles,
        isActive: editingUser.isActive,
      });
      setEditingUser(null);
      await loadUsers();
    } catch (error) {
      setError(userFacingError(error, 'Could not update the user.'));
    }
  };

  const handleDeleteUser = async (userId: string) => {
    try {
      await nocaiAPI.admin.deleteUser(userId);
      await loadUsers();
    } catch (error) {
      setError(userFacingError(error, 'Could not delete the user.'));
    } finally {
      setShowDeleteUserConfirm(false);
      setDeletingUserId(null);
    }
  };

  const tabs = [
    { id: 'users', label: 'Users', icon: Users },
    { id: 'roles', label: 'Roles', icon: Shield },
    { id: 'audit', label: 'Audit', icon: Activity },
    { id: 'jobs', label: 'Jobs', icon: HardDrive },
    { id: 'health', label: 'Health', icon: Monitor },
  ];

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="relative z-[60] flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-card p-4 text-sm text-destructive"><span>{error}</span><Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button></div>}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Administration</h1>
        <p className="text-muted-foreground">System administration and monitoring</p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center gap-1 bg-muted rounded-lg p-1" role="tablist">
            {tabs.map(tab => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => navigate(`/admin/${tab.id}`)}
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
          {activeTab === 'users' && (
            <UsersTab
              users={users}
              loading={usersLoading}
              onRefresh={loadUsers}
              onCreate={() => setShowCreateUserDialog(true)}
              onEdit={setEditingUser}
              onDelete={setDeletingUserId}
              creating={creatingUser}
              newUser={newUser}
              setNewUser={setNewUser}
              onCreateUser={handleCreateUser}
              onUpdateUser={handleUpdateUser}
              onDeleteUser={handleDeleteUser}
              showCreateDialog={showCreateUserDialog}
              setShowCreateDialog={setShowCreateUserDialog}
              deletingId={deletingUserId}
              showDeleteConfirm={showDeleteUserConfirm}
              setShowDeleteConfirm={setShowDeleteUserConfirm}
              editingUser={editingUser}
              setEditingUser={setEditingUser}
              onUpdate={handleUpdateUser}
            />
          )}
          {activeTab === 'roles' && (
            <RolesTab roles={roles} loading={rolesLoading} onRefresh={loadRoles} />
          )}
          {activeTab === 'audit' && (
            <AuditTab auditLogs={auditLogs} loading={auditLoading} onRefresh={loadAudit} filters={auditFilters} setFilters={setAuditFilters} />
          )}
          {activeTab === 'jobs' && (
            <JobsTab jobs={jobs} loading={jobsLoading} onRefresh={loadJobs} filters={jobsFilters} setFilters={setJobsFilters} />
          )}
          {activeTab === 'health' && (
            <HealthTab health={health} loading={healthLoading} onRefresh={loadHealth} />
          )}
        </CardContent>
      </Card>

      {/* Create User Dialog */}
      <Dialog open={showCreateUserDialog} onOpenChange={setShowCreateUserDialog} title="Create User">
        <div className="space-y-4">
          <Input
            label="Username"
            value={newUser.username}
            onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
            placeholder="Enter username"
            autoFocus
          />
          <Input
            label="Password"
            type="password"
            value={newUser.password}
            onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
            placeholder="Enter password (min 12 chars)"
          />
          <Input
            label="Display Name (optional)"
            value={newUser.displayName}
            onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })}
            placeholder="Display name"
          />
          <Input
            label="Email (optional)"
            type="email"
            value={newUser.email}
            onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
            placeholder="email@example.com"
          />
          <div>
            <label className="block text-sm font-medium mb-2">Roles</label>
            <div className="flex flex-wrap gap-2">
              {['administrator', 'knowledge_manager', 'operator'].map(role => (
                <label key={role} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newUser.roles.includes(role)}
                    onChange={(e) => setNewUser({
                      ...newUser,
                      roles: e.target.checked
                        ? [...newUser.roles, role]
                        : newUser.roles.filter(r => r !== role)
                    })}
                    className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
                  />
                  <span className="text-sm capitalize">{role.replace('_', ' ')}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowCreateUserDialog(false)}>Cancel</Button>
            <Button onClick={handleCreateUser} isLoading={creatingUser} disabled={!newUser.username || !newUser.password}>
              {creatingUser ? 'Creating...' : 'Create User'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Edit User Dialog */}
      {editingUser && (
        <Dialog open onOpenChange={(open) => { if (!open) setEditingUser(null); }} title={`Edit User: ${editingUser.username}`}>
          <div className="space-y-4">
            <Input
              label="Display Name"
              value={editingUser.displayName || ''}
              onChange={(e) => setEditingUser({ ...editingUser!, displayName: e.target.value })}
            />
            <Input
              label="Email"
              type="email"
              value={editingUser.email || ''}
              onChange={(e) => setEditingUser({ ...editingUser!, email: e.target.value })}
            />
            <div>
              <label className="block text-sm font-medium mb-2">Roles</label>
              <div className="flex flex-wrap gap-2">
                {['administrator', 'knowledge_manager', 'operator'].map(role => (
                  <label key={role} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={editingUser.roles.includes(role)}
                      onChange={(e) => setEditingUser({
                        ...editingUser!,
                        roles: e.target.checked
                          ? [...editingUser!.roles, role]
                          : editingUser!.roles.filter(r => r !== role)
                      })}
                      className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
                    />
                    <span className="text-sm capitalize">{role.replace('_', ' ')}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={editingUser.isActive}
                onChange={(e) => setEditingUser({ ...editingUser!, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
                id="is-active"
              />
              <label htmlFor="is-active" className="text-sm">Active</label>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
              <Button onClick={handleUpdateUser}>Save Changes</Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Delete User Confirmation */}
      <AlertDialog
        open={showDeleteUserConfirm}
        onOpenChange={setShowDeleteUserConfirm}
        title="Delete User"
        description="Are you sure you want to delete this user? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={() => deletingUserId && handleDeleteUser(deletingUserId)}
        variant="destructive"
      />
    </div>
  );
};

const UsersTab = ({ 
  users, loading, onRefresh, onCreate, onEdit, onDelete, creating, newUser, setNewUser, onCreateUser, 
  onUpdateUser, onDeleteUser, showCreateDialog, setShowCreateDialog, deletingId, showDeleteConfirm, 
  setShowDeleteConfirm, editingUser, setEditingUser, onUpdate 
}: any) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold">Users ({users.length})</h2>
      <Button onClick={onCreate}><Plus className="w-4 h-4 mr-2" /> Add User</Button>
    </div>
    {loading ? (
      <div className="flex items-center justify-center py-8"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Username</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Display Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Email</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Roles</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Last Login</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map((u: User) => (
              <tr key={u.id} className="hover:bg-accent/50">
                <td className="px-4 py-3 font-medium">{u.username}</td>
                <td className="px-4 py-3">{u.displayName || '-'}</td>
                <td className="px-4 py-3 text-muted-foreground">{u.email || '-'}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1">
                    {u.roles.map((r: string) => (
                      <Badge key={r} variant={r === 'administrator' ? 'destructive' : 'default'}>{r.replace('_', ' ')}</Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <Badge variant={u.isActive ? 'success' : 'secondary'}>
                    {u.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {u.lastLoginAt ? parseApiTimestamp(u.lastLoginAt).toLocaleDateString() : 'Never'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(u)}>
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    {(
                      <Button variant="ghost" size="sm" onClick={() => { onDelete(u.id); setShowDeleteConfirm(true); }} className="text-destructive hover:text-destructive">
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

const RolesTab = ({ roles, loading, onRefresh }: any) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold">Roles & Permissions</h2>
      <Button variant="outline" onClick={onRefresh}><Loader2 className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    {loading ? (
      <div className="flex items-center justify-center py-8"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
    ) : (
      <div className="space-y-4">
        {roles.map((role: Role) => (
          <Card key={role.id}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>{role.name}</CardTitle>
                  <CardDescription>{role.description}</CardDescription>
                </div>
                <Badge variant={role.isSystem ? 'destructive' : 'secondary'}>
                  {role.isSystem ? 'System' : 'Custom'}
                </Badge>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {role.permissions.map((p: string) => (
                  <Badge key={p} variant="outline">{p}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )}
  </div>
);

const AuditTab = ({ auditLogs, loading, onRefresh, filters, setFilters }: any) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between flex-wrap gap-4">
      <h2 className="text-lg font-semibold">Audit Log</h2>
      <div className="flex items-center gap-2 flex-wrap">
        <Input placeholder="Actor ID" value={filters.actorId} onChange={(e) => setFilters({...filters, actorId: e.target.value})} className="w-48" />
        <Input placeholder="Action" value={filters.action} onChange={(e) => setFilters({...filters, action: e.target.value})} className="w-48" />
        <Input placeholder="Resource Type" value={filters.resourceType} onChange={(e) => setFilters({...filters, resourceType: e.target.value})} className="w-48" />
        <Button onClick={onRefresh} isLoading={loading}><Loader2 className="w-4 h-4 mr-2" /> Refresh</Button>
      </div>
    </div>
    {loading ? (
      <div className="flex items-center justify-center py-8"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Time</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Actor</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Action</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Resource</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Outcome</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {auditLogs.map((log: AuditEntry) => (
              <tr key={log.id} className="hover:bg-accent/50">
                <td className="px-4 py-3 text-sm text-muted-foreground">{parseApiTimestamp(log.timestamp).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm">{log.actorName || log.actorId || 'System'}</td>
                <td className="px-4 py-3 text-sm font-mono text-muted-foreground">{log.action}</td>
                <td className="px-4 py-3 text-sm">
                  {log.resourceType && log.resourceId && (
                    <span className="font-mono">{log.resourceType}:{log.resourceId.substring(0,8)}...</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <Badge variant={log.outcome === 'success' ? 'success' : 'destructive'}>
                    {log.outcome}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{log.ipAddress}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

const JobsTab = ({ jobs, loading, onRefresh, filters, setFilters }: any) => (
  <div className="space-y-4">
    <div className="flex items-center justify-between flex-wrap gap-4">
      <h2 className="text-lg font-semibold">Ingestion Jobs</h2>
      <div className="flex items-center gap-2 flex-wrap">
        <select value={filters.status} onChange={(e) => setFilters({...filters, status: e.target.value})} className="h-10 px-3 border border-input rounded-lg">
          <option value="">All Status</option>
          <option value="pending">Pending</option>
          <option value="running">Running</option>
          <option value="completed">Completed</option>
          <option value="failed">Failed</option>
        </select>
        <Button onClick={onRefresh} isLoading={loading}><Loader2 className="w-4 h-4 mr-2" /> Refresh</Button>
      </div>
    </div>
    {loading ? (
      <div className="flex items-center justify-center py-8"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border">
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Document</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Status</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Priority</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Stage</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Progress</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-muted-foreground">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {jobs.map((job: JobProgress) => (
              <tr key={job.id} className="hover:bg-accent/50">
                <td className="px-4 py-3 text-sm font-mono">{job.documentId.substring(0,8)}...</td>
                <td className="px-4 py-3">
                  <Badge variant={
                    job.status === 'completed' ? 'success' :
                    job.status === 'failed' ? 'destructive' :
                    job.status === 'running' ? 'default' : 'secondary'
                  }>{job.status}</Badge>
                </td>
                <td className="px-4 py-3 text-sm">P{job.priority}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{job.currentStage || '-'}</td>
                <td className="px-4 py-3">
                  <div className="w-32 h-2 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{parseApiTimestamp(job.createdAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </div>
);

const HealthTab = ({ health, loading, onRefresh }: any) => (
  <div className="space-y-6">
    <div className="flex items-center justify-between">
      <h2 className="text-lg font-semibold">System Health</h2>
      <Button onClick={onRefresh} isLoading={loading}><Loader2 className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    {loading ? (
      <div className="flex items-center justify-center py-8"><Loader2 className="w-8 h-8 text-primary animate-spin" /></div>
    ) : health ? (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <HealthCard title="Backend API" status={health.backend} icon={Monitor} />
        <HealthCard title="Database" status={health.database} icon={HardDrive} />
        <HealthCard title="Model Runtime" status={health.modelRuntime} icon={Monitor} />
        <HealthCard title="Embedding Runtime" status={health.embeddingRuntime} icon={Monitor} />
      </div>
    ) : (
      <p className="text-muted-foreground">Health data unavailable</p>
    )}
    {health && (
      <Card>
        <CardHeader>
          <CardTitle>Resources</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-sm text-muted-foreground">Storage</p>
              <p className="text-2xl font-bold">{health.storage.freeGB.toFixed(1)} GB</p>
              <p className="text-sm text-muted-foreground">Free of {health.storage.totalGB.toFixed(1)} GB ({health.storage.usagePercent.toFixed(1)}% used)</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-sm text-muted-foreground">Memory</p>
              <p className="text-2xl font-bold">{health.memory.availableMB.toFixed(0)} MB</p>
              <p className="text-sm text-muted-foreground">Available of {health.memory.usedMB.toFixed(0)} MB used</p>
            </div>
            <div className="p-4 rounded-lg bg-muted/50">
              <p className="text-sm text-muted-foreground">Job Workers</p>
              <p className="text-2xl font-bold">{health.jobWorkers.active}</p>
              <p className="text-sm text-muted-foreground">Active, {health.jobWorkers.queued} queued</p>
            </div>
          </div>
        </CardContent>
      </Card>
    )}
  </div>
);

const HealthCard = ({ title, status, icon: Icon }: { title: string; status: string; icon: any }) => (
  <Card>
    <CardContent className="pt-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Icon className="w-6 h-6 text-muted-foreground" />
          <span className="font-medium">{title}</span>
        </div>
        <Badge variant={
          status === 'healthy' ? 'success' :
          status === 'degraded' ? 'warning' : 'destructive'
        }>
          {status}
        </Badge>
      </div>
    </CardContent>
  </Card>
);
