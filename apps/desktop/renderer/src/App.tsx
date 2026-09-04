import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
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

const ProtectedRoute = ({ children, requiredPermission }: { children: React.ReactNode; requiredPermission?: string }) => {
  const { isAuthenticated, isLoading } = useAuthStore();
  
  if (isLoading) {
    return <LoadingScreen message="Checking authentication..." />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }
  
  // TODO: Check specific permission if required
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
  const { checkSession } = useAuthStore();
  const [backendReady, setBackendReady] = useState(false);
  const [backendError, setBackendError] = useState<string | null>(null);

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const health = await nocaiAPI.system.getHealth();
        setBackendReady(health.status === 'ready');
        setBackendError(null);
      } catch (error: any) {
        setBackendReady(false);
        setBackendError(error.message || 'Backend unavailable');
      }
    };

    checkBackend();
    const interval = setInterval(checkBackend, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  return (
    <>
      <BackendStatusBanner isReady={backendReady} error={backendError} />
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
          <Route path="/admin/*" element={<Admin />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </>
  );
}

export default function App() {
  return <AppContent />;
}
