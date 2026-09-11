import React, { useState, useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import { Loader2, MessageSquare, Settings, Plus, Zap } from 'lucide-react';

interface ChatContainerProps {
  children: React.ReactNode;
  className?: string;
}

export const ChatContainer = ({ children, className = '' }: ChatContainerProps) => {
  return (
    <div className={clsx(
      'flex flex-col h-full bg-background border border-border rounded-lg shadow-sm',
      className
    )}>
      {children}
    </div>
  );
};

interface ChatHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode[];
  className?: string;
}

export const ChatHeader = ({ title, subtitle, actions, className = '' }: ChatHeaderProps) => {
  return (
    <div className={clsx(
      'flex items-center justify-between p-4 border-b border-border',
      className
    )}>
      <div className="flex flex-col">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {actions?.map((action, index) => (
          <React.Fragment key={index}>{action}</React.Fragment>
        ))}
      </div>
    </div>
  );
};

interface ChatContentProps {
  children: React.ReactNode;
  className?: string;
}

export const ChatContent = ({ children, className = '' }: ChatContentProps) => {
  return (
    <div className={clsx(
      'flex-1 overflow-hidden',
      className
    )}>
      {children}
    </div>
  );
};

interface ChatFooterProps {
  children: React.ReactNode;
  className?: string;
}

export const ChatFooter = ({ children, className = '' }: ChatFooterProps) => {
  return (
    <div className={clsx(
      'p-4 border-t border-border',
      className
    )}>
      {children}
    </div>
  );
};

interface LoadingIndicatorProps {
  message?: string;
  className?: string;
}

export const LoadingIndicator = ({ message = 'Thinking...', className = '' }: LoadingIndicatorProps) => {
  return (
    <div className={clsx(
      'flex items-center justify-center h-full',
      className
    )}>
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    </div>
  );
};