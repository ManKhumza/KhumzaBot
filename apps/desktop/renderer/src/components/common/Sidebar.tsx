import React, { useState } from 'react';
import { clsx } from 'clsx';
import { 
  MessageSquare,
  FileText,
  Database,
  Settings,
  Plus,
  Search,
  Home,
  Activity,
  Brain,
  Zap,
  AlertTriangle,
  CheckCircle,
  Clock,
  Menu,
  X
} from 'lucide-react';

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  count?: number;
  onClick?: () => void;
  className?: string;
}

const SidebarItem = ({ 
  icon, 
  label, 
  active = false, 
  count, 
  onClick,
  className = ''
}: SidebarItemProps) => {
  return (
    <button
      className={clsx(
        'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent',
        active ? 'bg-accent text-primary font-medium' : 'text-muted-foreground',
        className
      )}
      onClick={onClick}
    >
      <div className="w-5 h-5 flex items-center justify-center">
        {icon}
      </div>
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span className="rounded-full bg-primary text-primary-foreground text-xs px-2 py-0.5">
          {count}
        </span>
      )}
    </button>
  );
};

interface SidebarProps {
  activeItem: string;
  onItemSelect: (item: string) => void;
  className?: string;
}

export const Sidebar = ({ activeItem, onItemSelect, className = '' }: SidebarProps) => {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  const menuItems = [
    { id: 'chats', icon: MessageSquare, label: 'Chats' },
    { id: 'knowledge', icon: Database, label: 'Knowledge' },
    { id: 'models', icon: Brain, label: 'Models' },
    { id: 'settings', icon: Settings, label: 'Settings' },
  ];

  return (
    <div className={clsx(
      'flex flex-col h-full border-r border-border bg-background',
      isCollapsed ? 'w-16' : 'w-64',
      className
    )}>
      <div className="p-4 border-b border-border flex items-center justify-between">
        {!isCollapsed && (
          <h1 className="text-xl font-bold">NOC AI Assistant</h1>
        )}
        <button 
          onClick={toggleCollapse}
          className="p-1 rounded-md hover:bg-accent"
        >
          {isCollapsed ? <Menu className="h-5 w-5" /> : <X className="h-5 w-5" />}
        </button>
      </div>
      
      <div className="flex-1 p-2 space-y-1">
        {menuItems.map((item) => (
          <SidebarItem
            key={item.id}
            icon={React.createElement(item.icon, { className: 'h-4 w-4' })}
            label={item.label}
            active={activeItem === item.id}
            onClick={() => onItemSelect(item.id)}
          />
        ))}
      </div>
      
      <div className="p-4 border-t border-border">
        <SidebarItem
          icon={<Plus className="h-4 w-4" />}
          label="New Chat"
          onClick={() => onItemSelect('new-chat')}
        />
      </div>
    </div>
  );
};
