import React, { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { 
  Loader2, 
  AlertCircle,
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  Settings,
  RefreshCw,
  Activity,
  Zap,
  MessageSquare,
  FileText,
  FolderOpen,
  Copy,
  Send,
  Square,
  RotateCcw,
  X,
  ChevronDown,
  ChevronUp,
  Plus,
  Brain
} from 'lucide-react';

// Enhanced UI Components for Stellar Experience

interface EnhancedBadgeProps {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'success' | 'warning' | 'error';
  className?: string;
}

export const EnhancedBadge = ({ 
  children, 
  variant = 'primary', 
  className = '' 
}: EnhancedBadgeProps) => {
  const badgeClasses = clsx(
    'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium',
    {
      'bg-blue-100 text-blue-800 border border-blue-200': variant === 'primary',
      'bg-gray-100 text-gray-800 border border-gray-200': variant === 'secondary',
      'bg-green-100 text-green-800 border border-green-200': variant === 'success',
      'bg-yellow-100 text-yellow-800 border border-yellow-200': variant === 'warning',
      'bg-red-100 text-red-800 border border-red-200': variant === 'error',
    },
    className
  );

  return <span className={badgeClasses}>{children}</span>;
};

interface EnhancedButtonProps {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive';
  size?: 'small' | 'medium' | 'large';
  icon?: React.ReactNode;
  iconPosition?: 'left' | 'right';
  isLoading?: boolean;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
}

export const EnhancedButton = ({ 
  children, 
  variant = 'primary', 
  size = 'medium',
  icon,
  iconPosition = 'left',
  isLoading = false,
  className = '',
  onClick,
  disabled = false
}: EnhancedButtonProps) => {
  const buttonClasses = clsx(
    'inline-flex items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none',
    {
      'bg-primary text-primary-foreground hover:bg-primary/90': variant === 'primary',
      'bg-secondary text-secondary-foreground hover:bg-secondary/80': variant === 'secondary',
      'border border-input bg-background hover:bg-accent hover:text-accent-foreground': variant === 'outline',
      'hover:bg-accent hover:text-accent-foreground': variant === 'ghost',
      'bg-destructive text-destructive-foreground hover:bg-destructive/90': variant === 'destructive',
    },
    {
      'h-8 px-3 text-sm': size === 'small',
      'h-10 px-4 py-2': size === 'medium',
      'h-12 px-6 text-base': size === 'large',
    },
    className
  );

  const iconElement = isLoading ? (
    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
  ) : icon ? (
    <div className={iconPosition === 'left' ? 'mr-2' : 'ml-2'}>
      {icon}
    </div>
  ) : null;

  return (
    <button
      className={buttonClasses}
      onClick={onClick}
      disabled={disabled || isLoading}
    >
      {iconPosition === 'left' && iconElement}
      {children}
      {iconPosition === 'right' && iconElement}
    </button>
  );
};

interface EnhancedCardProps {
  children: React.ReactNode;
  title?: string;
  description?: string;
  className?: string;
}

export const EnhancedCard = ({ 
  children, 
  title, 
  description,
  className = ''
}: EnhancedCardProps) => {
  return (
    <div className={clsx(
      'rounded-lg border border-border bg-card text-card-foreground shadow-sm',
      className
    )}>
      {(title || description) && (
        <div className="border-b border-border p-4">
          {title && <h3 className="text-lg font-semibold">{title}</h3>}
          {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
        </div>
      )}
      <div className="p-4">
        {children}
      </div>
    </div>
  );
};

interface LoadingIndicatorProps {
  message?: string;
  className?: string;
}

export const LoadingIndicator = ({ message = 'Processing...', className = '' }: LoadingIndicatorProps) => {
  return (
    <div className={clsx(
      'flex flex-col items-center justify-center h-full',
      className
    )}>
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <span className="text-sm text-muted-foreground">{message}</span>
      </div>
    </div>
  );
};

interface StatusIndicatorProps {
  status: 'online' | 'offline' | 'busy' | 'idle';
  label?: string;
  className?: string;
}

export const StatusIndicator = ({ status, label, className = '' }: StatusIndicatorProps) => {
  const statusColors = {
    online: 'bg-green-500',
    offline: 'bg-gray-500',
    busy: 'bg-yellow-500',
    idle: 'bg-blue-500',
  };

  const statusLabels = {
    online: 'Online',
    offline: 'Offline',
    busy: 'Busy',
    idle: 'Idle',
  };

  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <div className={`w-3 h-3 rounded-full ${statusColors[status]}`} />
      <span className="text-sm text-muted-foreground">
        {label || statusLabels[status]}
      </span>
    </div>
  );
};

interface ToastProps {
  type: 'success' | 'error' | 'warning' | 'info';
  title: string;
  description?: string;
  className?: string;
}

export const Toast = ({ type, title, description, className = '' }: ToastProps) => {
  const toastClasses = clsx(
    'rounded-lg border p-4 shadow-lg',
    {
      'border-green-200 bg-green-50 text-green-800': type === 'success',
      'border-red-200 bg-red-50 text-red-800': type === 'error',
      'border-yellow-200 bg-yellow-50 text-yellow-800': type === 'warning',
      'border-blue-200 bg-blue-50 text-blue-800': type === 'info',
    },
    className
  );

  const iconMap = {
    success: <CheckCircle className="h-5 w-5" />,
    error: <AlertCircle className="h-5 w-5" />,
    warning: <AlertCircle className="h-5 w-5" />,
    info: <Clock className="h-5 w-5" />,
  };

  return (
    <div className={toastClasses}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          {iconMap[type]}
        </div>
        <div>
          <h4 className="font-semibold">{title}</h4>
          {description && <p className="text-sm mt-1">{description}</p>}
        </div>
      </div>
    </div>
  );
};
