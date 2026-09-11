import React, { useState, useEffect } from 'react';
import { nocaiAPI } from '@/utils/api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/common/Card';
import { Badge } from '@/components/common/Badge';
import { Search as SearchIcon, Loader2, FileText, ChevronDown, ChevronUp, Copy, Eye, Database } from 'lucide-react';
import { clsx } from 'clsx';
import type { SearchResult } from '@/types';
import { userFacingError } from '@/utils/errors';

export const Search = () => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [collections, setCollections] = useState<any[]>([]);
  const [selectedCollections, setSelectedCollections] = useState<string[]>([]);
  const [topK, setTopK] = useState(10);
  const [hybridAlpha, setHybridAlpha] = useState(0.5);
  const [enableReranking, setEnableReranking] = useState(false);
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    loadCollections();
  }, []);

  const loadCollections = async () => {
    try {
      const data = await nocaiAPI.knowledge.listCollections();
      setCollections(data);
    } catch (error) {
      setError(userFacingError(error, 'Could not load knowledge collections.'));
    }
  };

  const handleSearch = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const data = await nocaiAPI.knowledge.search({
        query: query.trim(),
        collectionIds: selectedCollections.length > 0 ? selectedCollections : undefined,
        topK,
        enableHybrid: true,
        hybridAlpha,
        enableReranking,
      });
      setResults(data);
    } catch (error) {
      setError(userFacingError(error, 'Knowledge search failed. Check diagnostics and retry.'));
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSearch();
    }
  };

  const toggleExpand = (chunkId: string) => {
    setExpandedResults(prev => {
      const next = new Set(prev);
      if (next.has(chunkId)) {
        next.delete(chunkId);
      } else {
        next.add(chunkId);
      }
      return next;
    });
  };

  const copyContent = async (content: string) => {
    try { await navigator.clipboard.writeText(content); setNotice('Search result copied.'); }
    catch { setError('Could not copy the result. Select the text and copy it manually.'); }
  };

  return (
    <div className="space-y-6">
      {error && <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">{error}</div>}
      {notice && <p role="status" className="text-sm">{notice}</p>}
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Search Knowledge</h1>
        <p className="text-muted-foreground">Search across your document collections</p>
      </div>

      {/* Search Input */}
      <Card>
        <CardContent className="pt-6">
          <div className="space-y-4">
            <div className="relative">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-muted-foreground" />
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Enter your search query..."
                className="w-full min-h-[100px] pl-10 pr-4 py-3 bg-card border border-input rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                rows={3}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4">
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Collections:</label>
                <div className="flex flex-wrap gap-1">
                  {collections.map(c => (
                    <label key={c.id} className="flex items-center gap-1 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedCollections.includes(c.id)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setSelectedCollections(prev => [...prev, c.id]);
                          } else {
                            setSelectedCollections(prev => prev.filter(id => id !== c.id));
                          }
                        }}
                        className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
                      />
                      <span className="text-sm">{c.name}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Top K:</label>
                <select
                  value={topK}
                  onChange={(e) => setTopK(Number(e.target.value))}
                  className="w-24 h-8 px-2 border border-input rounded-lg bg-background"
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={20}>20</option>
                  <option value={50}>50</option>
                </select>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-foreground">Hybrid α:</label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.1"
                  value={hybridAlpha}
                  onChange={(e) => setHybridAlpha(Number(e.target.value))}
                  className="w-32"
                />
                <span className="text-sm text-muted-foreground w-8">{hybridAlpha.toFixed(1)}</span>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enableReranking}
                  disabled
                  title="Reranking requires a supported local reranker runtime."
                  className="w-4 h-4 rounded border-input text-primary focus:ring-primary"
                />
                <span className="text-sm">Reranking unavailable: no supported reranker runtime</span>
              </label>

              <Button onClick={handleSearch} isLoading={loading} disabled={!query.trim() || loading}>
                <SearchIcon className="w-4 h-4 mr-2" />
                {loading ? 'Searching...' : 'Search'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results */}
      <Card>
        <CardHeader>
          <CardTitle>Results</CardTitle>
          <CardDescription>{results.length} matches found</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-8 h-8 text-primary animate-spin" />
            </div>
          ) : results.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <FileText className="w-12 h-12 text-muted-foreground/50 mb-4" />
              <h3 className="text-lg font-medium text-foreground mb-2">No results found</h3>
              <p className="text-muted-foreground">Try adjusting your search query or filters</p>
            </div>
          ) : (
            <div className="space-y-4">
              {results.map((result, index) => (
                <SearchResultCard
                  key={result.chunkId}
                  result={result}
                  index={index + 1}
                  expanded={expandedResults.has(result.chunkId)}
                  onToggle={() => toggleExpand(result.chunkId)}
                  onCopy={copyContent}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

const SearchResultCard = ({ result, index, expanded, onToggle, onCopy }: { 
  result: SearchResult; 
  index: number; 
  expanded: boolean; 
  onToggle: () => void; 
  onCopy: (text: string) => void; 
}) => {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="p-4 bg-muted/50">
        <div className="flex items-start gap-3">
          <span className="flex-shrink-0 w-7 h-7 rounded-full bg-primary/10 text-primary text-sm font-medium flex items-center justify-center">
            {index}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-sm mb-2">
              <span className="font-medium text-foreground">{result.metadata?.documentName || 'Unknown Document'}</span>
              <Badge variant="secondary" className="text-xs">{result.metadata?.collectionName || 'Unknown Collection'}</Badge>
              {result.pageStart && (
                <Badge variant="outline" className="text-xs">Page {result.pageStart}</Badge>
              )}
              {result.sectionTitle && (
                <Badge variant="outline" className="text-xs">{result.sectionTitle}</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground line-clamp-2">{result.content.substring(0, 300)}...</p>
            <div className="flex items-center gap-2 mt-2">
              <Button variant="ghost" size="sm" onClick={onToggle}>
                {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                {expanded ? 'Show less' : 'Show more'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onCopy(result.content)}>
                <Copy className="w-3 h-3" />
              </Button>
              <span className="text-xs text-muted-foreground ml-auto">Score: {result.score.toFixed(3)}</span>
            </div>
          </div>
        </div>
        {expanded && (
          <div className="border-t border-border p-4 bg-background">
            <div className="font-mono text-sm text-foreground bg-muted/50 p-3 rounded border border-border whitespace-pre-wrap">
              {result.content}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <Button variant="ghost" size="sm" onClick={() => onCopy(result.content)}>
                <Copy className="w-3 h-3 mr-1" />
                Copy full text
              </Button>
              <span className="text-xs text-muted-foreground">Source: {result.metadata?.documentName}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
