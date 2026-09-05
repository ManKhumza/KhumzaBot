import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Activity, AlertCircle, Lock, User } from 'lucide-react';

export const Login = () => {
  const navigate = useNavigate();
  const { login, error: authError, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const loadStatus = async () => {
      try {
        const status = await nocaiAPI.auth.getStatus();
        if (!cancelled) setNeedsSetup(status.needsSetup);
      } catch {
        // Electron emits a ready event once the private backend is available.
      }
    };

    loadStatus();
    const unsubscribe = window.nocai?.onBackendStatusChange((status) => {
      if (status.status === 'ready') loadStatus();
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

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
      setError(err.message || 'Invalid username or password');
    } finally {
      setIsLoading(false);
    }
  };

  const displayError = error || authError;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-md shadow-none">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-lg bg-primary text-primary-foreground">
            <Activity className="w-7 h-7" />
          </div>
          <CardTitle className="text-2xl">
            {needsSetup === null ? 'Starting local services' : needsSetup ? 'Create your administrator' : 'NOC AI Assistant'}
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

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading || needsSetup === null}>
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
          <p className="text-xs text-muted-foreground">
            Version 1.0.2
          </p>
        </CardFooter>
      </Card>
    </div>
  );
};
