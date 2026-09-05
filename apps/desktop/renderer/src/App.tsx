import { useCallback, useEffect, useState } from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
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

const ProtectedRoute = ({ children, administratorOnly = false }: { children: React.ReactNode; administratorOnly?: boolean }) => {
  const { isAuthenticated, isLoading, user } = useAuthStore();
  const location = useLocation();
  
  if (isLoading) {
    return <LoadingScreen message="Checking authentication..." />;
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

  const checkBackend = useCallback(async () => {
    try {
      const health = await nocaiAPI.system.getHealth();
      setBackendReady(health.status === 'ready');
      setBackendError(health.status === 'ready' ? null : 'Local services are still starting');
    } catch (error) {
      setBackendReady(false);
      setBackendError(error instanceof Error ? error.message : 'Backend unavailable');
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
      } else if (status.status === 'error') {
        setBackendReady(false);
        setBackendError(status.error || 'Backend unavailable');
      }
    });
  }, [checkBackend]);

  return (
    <>
      <BackendStatusBanner isReady={backendReady} error={backendError} onRetry={checkBackend} />
      <Routes>
        <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
        <Route
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route path="/" element={<Home />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/chats/:conversationId" element={<ChatView />} />
          <Route path="/models" element={<Models />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/search" element={<Search />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/admin/*" element={<ProtectedRoute administratorOnly><Admin /></ProtectedRoute>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return <AppContent />;
}
