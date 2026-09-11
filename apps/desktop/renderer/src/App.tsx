import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import { Layout } from '@/components/layout/Layout';
import { Login } from '@/pages/Login';
import { Home } from '@/pages/Home';
import { Chats } from '@/pages/Chats';
import { ChatView } from '@/pages/ChatView';
import { Models } from '@/pages/Models';
import { Knowledge } from '@/pages/Knowledge';
import { Search } from '@/pages/Search';
import { Settings } from '@/pages/Settings';
import { Admin } from '@/pages/Admin';
import { NotFound } from '@/pages/NotFound';
import { LoadingScreen } from '@/components/common/LoadingScreen';
import { BackendStatusBanner } from '@/components/common/BackendStatusBanner';
import { Diagnostics } from '@/pages/Diagnostics';
import { userFacingError, withTimeout } from '@/utils/errors';

const ProtectedRoute = ({ children, administratorOnly = false }: { children: React.ReactNode; administratorOnly?: boolean }) => {
  const { isAuthenticated, isLoading, user } = useAuthStore();
  const location = useLocation();

  if (isLoading) {
    return <div><LoadingScreen message="Checking authentication..." /><Link className="fixed bottom-8 left-1/2 -translate-x-1/2 text-sm text-primary underline" to="/diagnostics">Open diagnostics</Link></div>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (user?.mustChangePassword && location.pathname !== '/settings') {
    return <Navigate to="/settings?password=required" replace />;
  }

  if (administratorOnly && !user?.roles.includes('administrator')) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

const PublicRoute = ({ children }: { children: React.ReactNode }) => {
  const { isAuthenticated, isLoading } = useAuthStore();

  if (isLoading) {
    return <LoadingScreen message="Checking authentication..." />;
  }

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

function AppContent() {
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const checkBackend = useCallback(async () => {
    try {
      const health = await withTimeout(nocaiAPI.system.getHealth(), 'Local services did not respond. Open diagnostics to retry startup.');
      setBackendReady(health.ready ?? health.status === 'ready');
      setBackendError(health.status === 'ready' ? null : health.ready ? 'Knowledge services need attention. Open diagnostics for details.' : 'Local services are still starting');
    } catch (error) {
      setBackendReady(false);
      setBackendError(userFacingError(error, 'Local services are unavailable.'));
    }
  }, []);

  useEffect(() => {
    checkBackend();
    const interval = setInterval(checkBackend, 30000);
    return () => clearInterval(interval);
  }, [checkBackend]);

  useEffect(() => {
    if (!window.nocai) return;
    return window.nocai.onBackendStatusChange((status) => {
      if (status.status === 'ready') {
        checkBackend();
      } else {
        setBackendReady(false);
        setBackendError(status.status === 'starting' ? null : userFacingError(status.error, 'Local services are unavailable.'));
      }
    });
  }, [checkBackend]);

  const retryBackend = async () => {
    if (checking) return;
    setChecking(true);
    try {
      await nocaiAPI.system.restartBackend();
      await checkBackend();
    } catch (error) {
      setBackendError(userFacingError(error));
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <BackendStatusBanner isReady={backendReady} error={backendError} onRetry={retryBackend} retrying={checking} />
        <div className="relative min-h-0 flex-1 overflow-auto">
          <Routes>
            <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
            <Route
              element={<Layout />}
            >
              <Route path="/diagnostics" element={<Diagnostics />} />
              <Route path="/" element={<ProtectedRoute><Home /></ProtectedRoute>} />
              <Route path="/chats" element={<ProtectedRoute><Chats /></ProtectedRoute>} />
              <Route path="/chats/:conversationId" element={<ProtectedRoute><ChatView /></ProtectedRoute>} />
              <Route path="/models" element={<ProtectedRoute><Models /></ProtectedRoute>} />
              <Route path="/knowledge" element={<ProtectedRoute><Knowledge /></ProtectedRoute>} />
              <Route path="/search" element={<ProtectedRoute><Search /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
              <Route path="/admin/*" element={<ProtectedRoute administratorOnly><Admin /></ProtectedRoute>} />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </div>
    </div>
  );
}

export default function App() {
  return <AppContent />;
}
