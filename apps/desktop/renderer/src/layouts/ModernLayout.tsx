import React, { useState } from 'react';
import { clsx } from 'clsx';
import { Header } from '@/components/common/Header';
import { Sidebar } from '@/components/common/Sidebar';
import { EnhancedButton } from '@/components/common/EnhancedUI';

interface ModernLayoutProps {
  children: React.ReactNode;
  activeSidebarItem: string;
  onSidebarItemClick: (item: string) => void;
  className?: string;
}

export const ModernLayout = ({ 
  children, 
  activeSidebarItem, 
  onSidebarItemClick,
  className = ''
}: ModernLayoutProps) => {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  return (
    <div className={clsx(
      'flex flex-col h-screen bg-background text-foreground',
      className
    )}>
      <Header onMenuToggle={toggleSidebar} />
      
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          activeItem={activeSidebarItem}
          onItemSelect={onSidebarItemClick}
          className={isSidebarCollapsed ? 'w-16' : 'w-64'}
        />
        
        <main className="flex-1 overflow-auto">
          {children}
        </main>
      </div>
    </div>
  );
};