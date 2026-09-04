import React from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/common/Button';
import { Home, Search } from 'lucide-react';

export const NotFound = () => (
  <div className="flex min-h-[60vh] items-center justify-center bg-background">
    <div className="text-center">
      <h1 className="text-9xl font-bold text-muted-foreground/20">404</h1>
      <h2 className="text-2xl font-semibold text-foreground mt-4 mb-2">Page Not Found</h2>
      <p className="text-muted-foreground mb-8 max-w-md mx-auto">
        The page you're looking for doesn't exist or has been moved.
      </p>
      <div className="flex items-center justify-center gap-4">
        <Button onClick={() => window.history.back()}>
          <Search className="w-4 h-4 mr-2" />
          Go Back
        </Button>
        <Link to="/">
          <Button variant="outline">
            <Home className="w-4 h-4 mr-2" />
            Home
          </Button>
        </Link>
      </div>
    </div>
  </div>
);
