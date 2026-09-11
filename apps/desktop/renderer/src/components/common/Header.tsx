import React, { useState } from 'react';
import { clsx } from 'clsx';
import { 
  Search,
  Settings,
  Activity,
  Bell,
  User,
  Menu,
  X
} from 'lucide-react';

interface HeaderProps {
  onMenuToggle?: () => void;
  className?: string;
}

export const Header = ({ onMenuToggle, className = '' }: HeaderProps) => {
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  return (
    <header className={clsx(
      'flex items-center justify-between p-4 border-b border-border bg-background',
      className
    )}>
      <div className="flex items-center gap-3">
        {onMenuToggle && (
          <button 
            onClick={onMenuToggle}
            className="p-1 rounded-md hover:bg-accent"
          >
            <Menu className="h-5 w-5" />
          </button>
        )}
        <h1 className="text-xl font-bold">NOC AI Assistant</h1>
      </div>
      
      <div className="flex items-center gap-2">
        <div className="relative">
          <button 
            onClick={() => setIsSearchOpen(!isSearchOpen)}
            className="p-2 rounded-md hover:bg-accent"
          >
            <Search className="h-4 w-4" />
          </button>
          {isSearchOpen && (
            <div className="absolute right-0 mt-2 w-64 bg-background border border-border rounded-lg shadow-lg p-2">
              <input 
                type="text" 
                placeholder="Search..." 
                className="w-full px-3 py-1 text-sm border border-input rounded"
              />
            </div>
          )}
        </div>
        
        <button className="p-2 rounded-md hover:bg-accent">
          <Bell className="h-4 w-4" />
        </button>
        
        <button className="p-2 rounded-md hover:bg-accent">
          <Settings className="h-4 w-4" />
        </button>
        
        <div className="flex items-center gap-2 ml-2">
          <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-white text-sm font-medium">
            U
          </div>
          <span className="text-sm font-medium">User</span>
        </div>
      </div>
    </header>
  );
};