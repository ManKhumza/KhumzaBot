import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { AppErrorBoundary } from '@/components/common/AppErrorBoundary';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import {
  Activity,
  ChevronRight,
  Cpu,
  Database,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { clsx } from 'clsx';

const navigation = [
  { name: 'Overview', href: '/', icon: LayoutDashboard },
  { name: 'Chats', href: '/chats', icon: MessageSquare },
  { name: 'Models', href: '/models', icon: Cpu },
  { name: 'Knowledge', href: '/knowledge', icon: Database },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Diagnostics', href: '/diagnostics', icon: Activity },
];

const adminNavigation = [
  { name: 'Users', href: '/admin/users', icon: Users },
  { name: 'Roles', href: '/admin/roles', icon: Shield },
  { name: 'Audit', href: '/admin/audit', icon: Activity },
  { name: 'Jobs', href: '/admin/jobs', icon: HardDrive },
  { name: 'Health', href: '/admin/health', icon: Monitor },
];

const getPageTitle = (pathname: string) => {
  if (pathname === '/') return 'Operations overview';
  if (pathname.startsWith('/chats/')) return 'Conversation';
  if (pathname.startsWith('/admin/')) {
    const section = pathname.split('/')[2] || 'Administration';
    return section.charAt(0).toUpperCase() + section.slice(1);
  }
  const section = pathname.split('/')[1] || 'Overview';
  return section.charAt(0).toUpperCase() + section.slice(1);
};

export const Layout = () => {
  const { user, logout } = useAuthStore();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [activeModelLabel, setActiveModelLabel] = useState('Checking model');
  const [knowledgeLabel, setKnowledgeLabel] = useState('Checking knowledge');

  const refreshWorkspaceStatus = useCallback(async () => {
    if (!user || user.mustChangePassword) return;
    const [healthResult, modelsResult, collectionsResult] = await Promise.allSettled([
      nocaiAPI.system.getHealth(),
      nocaiAPI.models.listModels('chat'),
      nocaiAPI.knowledge.listCollections(),
    ]);

    setBackendStatus(
      healthResult.status === 'fulfilled' && healthResult.value.status === 'ready' ? 'ready' : 'error'
    );

    if (modelsResult.status === 'fulfilled') {
      const activeModel = modelsResult.value.find((model) => model.status === 'active');
      setActiveModelLabel(activeModel?.name || 'No active model');
    } else {
      setActiveModelLabel('Model status unavailable');
    }

    if (collectionsResult.status === 'fulfilled') {
      const count = collectionsResult.value.length;
      setKnowledgeLabel(`${count} collection${count === 1 ? '' : 's'}`);
    } else {
      setKnowledgeLabel('Knowledge unavailable');
    }
  }, [user]);

  useEffect(() => {
    refreshWorkspaceStatus();
    const interval = setInterval(refreshWorkspaceStatus, 30000);
    return () => clearInterval(interval);
  }, [location.pathname, refreshWorkspaceStatus]);

  useEffect(() => {
    const loadDefaults = async () => {
      if (!user || user.mustChangePassword) return;
      try {
        const settings = await nocaiAPI.settings.get();
        setSidebarCollapsed(Boolean(settings.appearance.sidebarCollapsed));
      } catch {
        // The shell remains usable with its expanded default.
      }
    };
    loadDefaults();
  }, [user]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const toggleTheme = () => {
    const themes: Array<'light' | 'dark' | 'system'> = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    setTheme(themes[(currentIndex + 1) % themes.length]);
  };

  const themeIcon = theme === 'system'
    ? <Monitor className="h-5 w-5" />
    : resolvedTheme === 'dark'
      ? <Moon className="h-5 w-5" />
      : <Sun className="h-5 w-5" />;
  const showLabels = mobileSidebarOpen || !sidebarCollapsed;
  const isConversation = /^\/chats\/[^/]+/.test(location.pathname);

  const navLinkClass = ({ isActive }: { isActive: boolean }) => clsx(
    'flex h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
    !showLabels && 'justify-center px-0',
    isActive
      ? 'bg-primary/10 text-primary'
      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
  );

  return (
    <div className="h-full bg-background font-sans antialiased">
      {mobileSidebarOpen && (
        <button
          className="fixed inset-0 z-40 bg-black/45 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <aside
        className={clsx(
          'absolute inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-border bg-card transition-[transform,width] duration-200',
          mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
          sidebarCollapsed ? 'lg:w-16' : 'lg:w-64'
        )}
        aria-label="Main navigation"
      >
        <div className={clsx('flex h-16 items-center gap-3 border-b border-border px-4', !showLabels && 'justify-center px-2')}>
          <div className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Activity className="h-5 w-5" aria-hidden="true" />
          </div>
          {showLabels && <span className="truncate text-sm font-semibold">NOC AI Assistant</span>}
          {showLabels && (
            <button
              className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
              onClick={() => setMobileSidebarOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {user && !user.mustChangePassword && <div className="border-b border-border p-3">
          <button
            onClick={() => {
              navigate('/chats/new');
              setMobileSidebarOpen(false);
            }}
            className={clsx(
              'flex h-10 w-full items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90',
              !showLabels && 'justify-center px-0'
            )}
            title={!showLabels ? 'New chat' : undefined}
          >
            <Plus className="h-4 w-4 flex-none" />
            {showLabels && <span>New chat</span>}
          </button>
        </div>}

        <nav className="flex-1 overflow-y-auto p-2">
          <ul className="space-y-1">
            {navigation.filter((item) => user ? !user.mustChangePassword || ['/settings', '/diagnostics'].includes(item.href) : item.href === '/diagnostics').map((item) => (
              <li key={item.name}>
                <NavLink
                  to={item.href}
                  end={item.href === '/'}
                  className={navLinkClass}
                  title={!showLabels ? item.name : undefined}
                  onClick={() => setMobileSidebarOpen(false)}
                >
                  <item.icon className="h-5 w-5 flex-none" aria-hidden="true" />
                  {showLabels && <span>{item.name}</span>}
                </NavLink>
              </li>
            ))}
          </ul>

          {!user?.mustChangePassword && user?.roles.includes('administrator') && (
            <div className="mt-5 border-t border-border pt-4">
              {showLabels && (
                <p className="mb-2 px-3 text-xs font-semibold uppercase text-muted-foreground">Administration</p>
              )}
              <ul className="space-y-1">
                {adminNavigation.map((item) => (
                  <li key={item.name}>
                    <NavLink
                      to={item.href}
                      className={navLinkClass}
                      title={!showLabels ? item.name : undefined}
                      onClick={() => setMobileSidebarOpen(false)}
                    >
                      <item.icon className="h-5 w-5 flex-none" aria-hidden="true" />
                      {showLabels && <span>{item.name}</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </nav>

        <div className="space-y-1 border-t border-border p-2">
          {!user && <NavLink to="/login" className={navLinkClass}>Sign in</NavLink>}
          <button
            onClick={toggleTheme}
            className={clsx(
              'flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground',
              !showLabels && 'justify-center px-0'
            )}
            title={`Theme: ${theme}`}
            aria-label={`Current theme: ${theme}`}
          >
            {themeIcon}
            {showLabels && <span className="capitalize">{theme} theme</span>}
          </button>

          <button
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            className={clsx(
              'hidden h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground lg:flex',
              !showLabels && 'justify-center px-0'
            )}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            {showLabels && <span>Collapse sidebar</span>}
          </button>

          {user && showLabels && (
            <div className="border-t border-border pt-2">
              <div className="flex items-center gap-3 px-3 py-2">
                <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-secondary text-sm font-semibold text-secondary-foreground">
                  {(user.displayName || user.username).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{user.displayName || user.username}</p>
                  <p className="truncate text-xs capitalize text-muted-foreground">{user.roles[0]}</p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="flex h-10 w-full items-center gap-3 rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <LogOut className="h-5 w-5" />
                <span>Sign out</span>
              </button>
            </div>
          )}

          {user && !showLabels && (
            <button
              onClick={handleLogout}
              className="flex h-10 w-full items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-5 w-5" />
            </button>
          )}
        </div>
      </aside>

      <main
        className={clsx(
          'flex h-full min-h-0 min-w-0 flex-col transition-[margin] duration-200',
          sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
        )}
      >
        <header className="flex h-14 flex-none items-center justify-between border-b border-border bg-background px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="rounded-md p-2 text-muted-foreground hover:bg-accent lg:hidden"
              aria-label="Open menu"
            >
              <Menu className="h-5 w-5" />
            </button>
            <h1 className="truncate text-sm font-semibold">{getPageTitle(location.pathname)}</h1>
          </div>

          <div className="flex min-w-0 items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-2 text-xs font-medium" title="Local backend status">
              <span className={clsx(
                'h-2 w-2 rounded-full',
                backendStatus === 'ready' && 'bg-emerald-500',
                backendStatus === 'starting' && 'animate-pulse bg-amber-500',
                backendStatus === 'error' && 'bg-red-500'
              )} />
              <span className="hidden text-muted-foreground sm:inline">
                {backendStatus === 'ready' ? 'Local services ready' : backendStatus === 'starting' ? 'Starting services' : 'Service issue'}
              </span>
            </div>
            <div className="hidden min-w-0 items-center gap-2 border-l border-border pl-4 text-xs md:flex">
              <Cpu className="h-4 w-4 flex-none text-muted-foreground" />
              <span className="max-w-44 truncate">{activeModelLabel}</span>
            </div>
            <div className="hidden items-center gap-2 border-l border-border pl-4 text-xs xl:flex">
              <Database className="h-4 w-4 text-muted-foreground" />
              <span>{knowledgeLabel}</span>
            </div>
          </div>
        </header>

        <div className={clsx(
          'min-h-0 flex-1',
          isConversation ? 'overflow-hidden' : 'overflow-auto p-4 md:p-6'
        )}>
          <AppErrorBoundary resetKey={location.pathname} variant="page">
            <Outlet />
          </AppErrorBoundary>
        </div>
      </main>
    </div>
  );
};
