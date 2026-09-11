import { useCallback, useEffect, useState } from 'react';
import { Activity, Download, RefreshCw } from 'lucide-react';
import { Button } from '@/components/common/Button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/common/Card';
import { nocaiAPI, type LocalDiagnostics } from '@/utils/api';
import { userFacingError, withTimeout } from '@/utils/errors';

export const Diagnostics = () => {
  const [diagnostics, setDiagnostics] = useState<LocalDiagnostics | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const result = await withTimeout(nocaiAPI.system.getDiagnostics(), 'Desktop diagnostics did not respond. Restart the application.');
      setDiagnostics(result);
      setError(null);
    } catch (failure) { setError(userFacingError(failure)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const perform = async (action: 'restart' | 'export') => {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      if (action === 'restart') {
        await nocaiAPI.system.restartBackend();
        setNotice('Local services restarted. Return to sign in if your session has expired.');
      } else {
        const result = await nocaiAPI.system.exportDiagnostics();
        if (result.path) setNotice('Diagnostics exported to the location you selected.');
      }
      await refresh();
    } catch (failure) { setError(userFacingError(failure)); }
    finally { setBusy(null); }
  };

  return <div className="mx-auto max-w-5xl space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div><h2 className="text-2xl font-semibold">Local diagnostics</h2><p className="mt-1 text-sm text-muted-foreground">Startup status and recent desktop errors remain available when local services are offline.</p></div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void refresh()} disabled={busy !== null}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
        <Button variant="outline" onClick={() => void perform('export')} disabled={busy !== null} isLoading={busy === 'export'}><Download className="mr-2 h-4 w-4" />Export diagnostics</Button>
        <Button onClick={() => void perform('restart')} disabled={busy !== null} isLoading={busy === 'restart'}>Restart local services</Button>
      </div>
    </div>
    {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
    {notice && <p role="status" className="rounded-md border border-border bg-muted p-4 text-sm">{notice}</p>}
    {diagnostics && <>
      <Card><CardHeader><CardTitle><Activity className="mr-2 inline h-5 w-5" />Desktop and backend</CardTitle></CardHeader><CardContent>
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">Application version</dt><dd className="mt-1 font-medium">{diagnostics.version}</dd></div>
          <div><dt className="text-muted-foreground">Backend state</dt><dd className="mt-1 font-medium capitalize">{diagnostics.backend.state.replace(/_/g, ' ')}</dd></div>
          <div><dt className="text-muted-foreground">Recovery attempts</dt><dd className="mt-1">{diagnostics.backend.restartAttempts ?? 0}</dd></div>
          <div><dt className="text-muted-foreground">Local log directory</dt><dd className="mt-1 break-all font-mono text-xs">{diagnostics.paths.logs}</dd></div>
        </dl>
        {diagnostics.backend.lastError && <p className="mt-4 rounded bg-destructive/5 p-3 text-sm text-destructive">{userFacingError(diagnostics.backend.lastError)}</p>}
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Recent errors</CardTitle></CardHeader><CardContent>
        {diagnostics.recentErrors.length === 0 ? <p className="text-sm text-muted-foreground">No recent desktop errors were recorded.</p> : <ol className="space-y-3">{diagnostics.recentErrors.map((entry, index) => <li key={`${entry.timestamp}-${index}`} className="rounded-md border border-border p-3 text-sm">
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span>{entry.component || 'Desktop'} {entry.event || ''}</span><time>{new Date(entry.timestamp).toLocaleString()}</time></div>
          <p className="mt-2 break-words">{userFacingError(entry.message)}</p>
          {entry.correlationId && <p className="mt-2 font-mono text-xs text-muted-foreground">Reference: {entry.correlationId}</p>}
        </li>)}</ol>}
      </CardContent></Card>
    </>}
    <p className="text-xs text-muted-foreground">Diagnostics contain local service information. Exported reports exclude conversations, documents, and credentials.</p>
  </div>;
};
