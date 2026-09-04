import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { nocaiAPI } from '@/utils/api';
import {
  LayoutDashboard,
  MessageSquare,
  Cpu,
  Database,
  Search,
  Settings,
  Users,
  Shield,
  Activity,
  HardDrive,
  LogOut,
  Menu,
  X,
  ChevronRight,
  Plus,
  Moon,
  Sun,
  Monitor,
  Bell,
} from 'lucide-react';
import { useTheme } from '@/components/ThemeProvider';
import { clsx } from 'clsx';

const navigation = [
  { name: 'Home', href: '/', icon: LayoutDashboard, permission: null },
  { name: 'Chats', href: '/chats', icon: MessageSquare, permission: null },
  { name: 'Models', href: '/models', icon: Cpu, permission: 'models:list' },
  { name: 'Knowledge', href: '/knowledge', icon: Database, permission: 'knowledge:list' },
  { name: 'Search', href: '/search', icon: Search, permission: 'knowledge:list' },
  { name: 'Settings', href: '/settings', icon: Settings, permission: null },
];

const adminNavigation = [
  { name: 'Users', href: '/admin/users', icon: Users, permission: 'admin:users' },
  { name: 'Roles', href: '/admin/roles', icon: Shield, permission: 'admin:roles' },
  { name: 'Audit', href: '/admin/audit', icon: Activity, permission: 'admin:audit' },
  { name: 'Jobs', href: '/admin/jobs', icon: HardDrive, permission: 'admin:jobs' },
  { name: 'Health', href: '/admin/health', icon: Monitor, permission: 'admin:health' },
];

export const Layout = () => {
  const { user, logout } = useAuthStore();
  const { theme, resolvedTheme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [backendStatus, setBackendStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [activeModel, setActiveModel] = useState<string>('No model loaded');
  const [activeCollection, setActiveCollection] = useState<string>('No knowledge');

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const health = await nocaiAPI.admin.getHealth();
        setBackendStatus(health.backend === 'healthy' ? 'ready' : 'error');
      } catch {
        setBackendStatus('error');
      }
    };
    checkStatus();
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadDefaults = async () => {
      try {
        const settings = await nocaiAPI.settings.get();
        if (settings.appearance.sidebarCollapsed !== undefined) {
          setSidebarCollapsed(settings.appearance.sidebarCollapsed);
        }
      } catch {}
    };
    loadDefaults();
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const toggleTheme = () => {
    const themes: ('light' | 'dark' | 'system')[] = ['light', 'dark', 'system'];
    const currentIndex = themes.indexOf(theme);
    setTheme(themes[(currentIndex + 1) % themes.length]);
  };

  const getThemeIcon = () => {
    if (theme === 'system') return <Monitor className="w-5 h-5" />;
    return resolvedTheme === 'dark' ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />;
  };

  return (
    <div className="flex h-screen bg-background font-sans antialiased">
      {/* Mobile sidebar overlay */}
      {mobileSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed lg:relative z-50 flex flex-col bg-card border-r border-border transition-all duration-300',
          sidebarCollapsed ? 'w-16' : 'w-64',
          mobileSidebarOpen ? 'w-64' : 'lg:w-64'
        )}
        aria-label="Main navigation"
      >
        {/* Logo & Title */}
        <div className={clsx('flex items-center gap-3 p-4 border-b border-border', sidebarCollapsed && 'justify-center')}>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-primary text-primary-foreground">
            <Cpu className="w-5 h-5" />
          </div>
          {!sidebarCollapsed && (
            <span className="font-semibold text-lg text-foreground">NOC AI Assistant</span>
          )}
        </div>

        {/* New Chat Button */}
        {!sidebarCollapsed && (
          <div className="p-4 border-b border-border">
            <button
              onClick={() => navigate('/chats/new')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>New Chat</span>
            </button>
          </div>
        )}

        {/* Main Navigation */}
        <nav className="flex-1 overflow-y-auto p-2" aria-label="Main navigation">
          <ul className="space-y-1" role="list">
            {navigation.map((item) => (
              <li key={item.name}>
                <NavLink
                  to={item.href}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      sidebarCollapsed ? 'justify-center' : '',
                      isActive
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )
                  }
                  title={sidebarCollapsed ? item.name : undefined}
                  onClick={() => setMobileSidebarOpen(false)}
                >
                  <item.icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                  {!sidebarCollapsed && <span>{item.name}</span>}
                </NavLink>
              </li>
            ))}
          </ul>

          {/* Admin Section */}
          {user?.roles.includes('administrator') && (
            <>
              <li className="pt-4">
                <hr className="border-border" />
              </li>
              <li className="px-3 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {!sidebarCollapsed && 'Administration'}
              </li>
              <ul className="space-y-1">
                {adminNavigation.map((item) => (
                  <li key={item.name}>
                    <NavLink
                      to={item.href}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                          sidebarCollapsed ? 'justify-center' : '',
                          isActive
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                        )
                      }
                      title={sidebarCollapsed ? item.name : undefined}
                      onClick={() => setMobileSidebarOpen(false)}
                    >
                      <item.icon className="w-5 h-5 flex-shrink-0" aria-hidden="true" />
                      {!sidebarCollapsed && <span>{item.name}</span>}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>

        {/* Bottom: Theme toggle, Collapse, User */}
        <div className="p-4 border-t border-border space-y-2">
          <button
            onClick={toggleTheme}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
              sidebarCollapsed ? 'justify-center mx-auto' : 'w-full'
            )}
            title={theme === 'system' ? 'System theme' : theme === 'dark' ? 'Dark theme' : 'Light theme'}
            aria-label={`Current theme: ${theme}`}
          >
            {getThemeIcon()}
            {!sidebarCollapsed && <span className="capitalize">{theme}</span>}
          </button>

          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors',
              sidebarCollapsed ? 'justify-center mx-auto' : 'w-full'
            )}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed ? <ChevronRight className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            {!sidebarCollapsed && <span>{sidebarCollapsed ? 'Expand' : 'Collapse'}</span>}
          </button>

          {!sidebarCollapsed && user && (
            <div className="pt-2">
              <div className="flex items-center gap-3 px-3 py-2 text-sm">
                <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-primary-foreground font-medium">
                  {user.displayName?.[0] || user.username[0].toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-foreground truncate">{user.displayName || user.username}</p>
                  <p className="text-xs text-muted-foreground capitalize">{user.roles[0]}</p>
                </div>
              </div>
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                <LogOut className="w-5 h-5" />
                <span>Sign Out</span>
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main
        className={clsx(
          'flex-1 flex flex-col overflow-hidden',
          sidebarCollapsed ? 'lg:ml-16' : 'lg:ml-64'
        )}
      >
        {/* Top Bar */}
        <header className="flex items-center justify-between px-4 py-3 bg-background border-b border-border sticky top-0 z-30">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setMobileSidebarOpen(true)}
              className="lg:hidden p-2 rounded-lg text-muted-foreground hover:bg-accent"
              aria-label="Open menu"
            >
              <Menu className="w-6 h-6" />
            </button>
            <h1 className="text-lg font-semibold text-foreground hidden sm:block">
              {location.pathname === '/' ? 'Dashboard' : location.pathname.split('/').pop()?.replace(/-/g, ' ') || 'NOC AI Assistant'}
            </h1>
          </div>

          <div className="flex items-center gap-4">
            {/* Backend Status */}
            <div className="flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium">
              <span
                className={clsx(
                  'w-2 h-2 rounded-full',
                  backendStatus === 'ready' && 'bg-green-500',
                  backendStatus === 'starting' && 'bg-yellow-500 animate-pulse',
                  backendStatus === 'error' && 'bg-red-500'
                )}
              />
              <span className={clsx(
                backendStatus === 'ready' && 'text-green-700 dark:text-green-300',
                backendStatus === 'starting' && 'text-yellow-700 dark:text-yellow-300',
                backendStatus === 'error' && 'text-red-700 dark:text-red-300',
              )}>
                {backendStatus === 'ready' ? 'Ready' : backendStatus === 'starting' ? 'Starting...' : 'Error'}
              </span>
            </div>

            {/* Active Model */}
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border text-sm">
              <Cpu className="w-4 h-4 text-muted-foreground" />
              <span className="text-foreground truncate max-w-[200px]">{activeModel}</span>
            </div>

            {/* Active Collection */}
            <div className="hidden md:flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border text-sm">
              <Database className="w-4 h-4 text-muted-foreground" />
              <span className="text-foreground truncate max-w-[200px]">{activeCollection}</span>
            </div>

            {/* Theme Toggle (for collapsed sidebar) */}
            {sidebarCollapsed && (
              <button
                onClick={toggleTheme}
                className="p-2 rounded-lg text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                aria-label={`Current theme: ${theme}`}
              >
                {getThemeIcon()}
              </button>
            )}
          </div>
        </header>

        {/* Page Content */}
        <div className="flex-1 overflow-auto p-4 md:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
};