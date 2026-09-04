import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Loader2, Lock, User, AlertCircle } from 'lucide-react';
import { clsx } from 'clsx';

export const Login = () => {
  const navigate = useNavigate();
  const { login, error: authError, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    clearError();
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
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex items-center justify-center w-12 h-12 rounded-xl bg-primary text-primary-foreground">
            <Lock className="w-7 h-7" />
          </div>
          <CardTitle className="text-2xl">Sign in to NOC AI Assistant</CardTitle>
          <CardDescription>
            Enter your credentials to access your local AI assistant
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
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                autoComplete="username"
                disabled={isLoading}
                required
                className="pl-10"
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                label="Password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                disabled={isLoading}
                required
                className="pl-10"
              />
            </div>

            <Button type="submit" className="w-full" size="lg" isLoading={isLoading}>
              {isLoading ? 'Signing in...' : 'Sign In'}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex flex-col items-center gap-2">
          <p className="text-sm text-muted-foreground">
            Running completely offline. No data leaves this machine.
          </p>
          <p className="text-xs text-muted-foreground">
            Version 1.0.1
          </p>
        </CardFooter>
      </Card>
    </div>
  );
};
