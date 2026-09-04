import { useState } from 'react';

export function useTabs(initialTab: string) {
  const [activeTab, setActiveTab] = useState(initialTab);
  return [activeTab, setActiveTab] as const;
}