import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Activity, AlertCircle, Lock, User } from 'lucide-react';
import { userFacingError, withTimeout } from '@/utils/errors';

export const Login = () => {
  const navigate = useNavigate();
  const { login, error: authError, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setStatusError(null);
    try {
      const status = await withTimeout(nocaiAPI.auth.getStatus(), 'Local services are taking too long to start. Retry or open diagnostics.');
      setNeedsSetup(status.needsSetup);
    } catch (failure) {
      setStatusError(userFacingError(failure, 'Local services are unavailable. Retry or open diagnostics.'));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
    void nocaiAPI.system.getVersion().then(setVersion).catch(() => setVersion(null));
    const unsubscribe = window.nocai?.onBackendStatusChange((status) => {
      if (status.status === 'ready') loadStatus();
    });

    return () => {
      unsubscribe?.();
    };
  }, [loadStatus]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    clearError();

    if (needsSetup && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (needsSetup && password.length < 12) {
      setError('The administrator password must be at least 12 characters');
      return;
    }

    setIsLoading(true);

    try {
      await login(username, password);
      navigate('/');
    } catch (err: any) {
      setError(userFacingError(err, 'Invalid username or password'));
    } finally {
      setIsLoading(false);
    }
  };

  const displayError = error || authError;

  return (
    <div className="flex min-h-full items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-none">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-lg bg-primary text-primary-foreground">
            <Activity className="w-7 h-7" />
          </div>
          <CardTitle className="text-2xl">
            {needsSetup === null ? statusError ? 'Local services unavailable' : 'Starting local services' : needsSetup ? 'Create your administrator' : 'NOC AI Assistant'}
          </CardTitle>
          <CardDescription>
            {needsSetup === null
              ? 'Preparing your private operations workspace.'
              : needsSetup
              ? 'Set up the first local account for this installation.'
              : 'Sign in to your private operations workspace.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {statusError && <div className="mb-4 space-y-3 rounded-md border border-destructive/30 p-3"><p role="alert" className="text-sm text-destructive">{statusError}</p><Button variant="outline" onClick={() => void loadStatus()}>Retry connection</Button></div>}
          <form onSubmit={handleSubmit} className="space-y-4">
            {displayError && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm" role="alert">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <div className="relative">
              <User className="absolute bottom-3 left-3 w-4 h-4 text-muted-foreground" />
              <Input
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={needsSetup ? 'Choose an administrator username' : 'Enter your username'}
                autoComplete="username"
                disabled={isLoading || needsSetup === null}
                required
                className="pl-10"
              />
            </div>

            <div className="relative">
              <Lock className="absolute bottom-3 left-3 w-4 h-4 text-muted-foreground" />
              <Input
                label={needsSetup ? 'Administrator password' : 'Password'}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={needsSetup ? 'At least 12 characters' : 'Enter your password'}
                autoComplete={needsSetup ? 'new-password' : 'current-password'}
                minLength={needsSetup ? 12 : undefined}
                disabled={isLoading || needsSetup === null}
                required
                className="pl-10"
              />
            </div>

            {needsSetup && (
              <div className="relative">
                <Lock className="absolute bottom-3 left-3 w-4 h-4 text-muted-foreground" />
                <Input
                  label="Confirm password"
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Enter the password again"
                  autoComplete="new-password"
                  minLength={12}
                  disabled={isLoading}
                  required
                  className="pl-10"
                />
              </div>
            )}

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading || (needsSetup === null && !statusError)} disabled={needsSetup === null}>
              {needsSetup === null
                ? 'Preparing...'
                : isLoading
                  ? (needsSetup ? 'Creating account...' : 'Signing in...')
                  : (needsSetup ? 'Create administrator' : 'Sign in')}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col items-center gap-2">
          <p className="text-sm text-muted-foreground">
            Offline by default. Your chats and documents stay on this machine.
          </p>
          <Link className="text-sm text-primary underline" to="/diagnostics">Open diagnostics</Link>
          {version && <p className="text-xs text-muted-foreground">Version {version}</p>}
        </CardFooter>
      </Card>
    </div>
  );
};
