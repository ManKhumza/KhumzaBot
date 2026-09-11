import React, { useState } from 'react';
import { Button } from '@/components/common/Button';
import { Textarea } from '@/components/common/Textarea';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/common/Card';
import { Input } from '@/components/common/Input';
import { clsx } from 'clsx';
import { Save, Settings, Bot, Zap, AlertTriangle, CheckCircle, Loader2 } from 'lucide-react';

interface BehaviorEditorProps {
  initialInstructions: string;
  onSave: (instructions: string) => Promise<void>;
  className?: string;
}

export const BehaviorEditor = ({ 
  initialInstructions, 
  onSave,
  className = ''
}: BehaviorEditorProps) => {
  const [instructions, setInstructions] = useState(initialInstructions);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    
    try {
      await onSave(instructions);
      setSaveSuccess(true);
      // Reset success indicator after 3 seconds
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (error) {
      setSaveError('Failed to save behavior instructions. Please try again.');
      console.error('Failed to save behavior instructions:', error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Bot className="h-5 w-5 text-primary" />
          <CardTitle>Behavior Configuration</CardTitle>
        </div>
        <CardDescription>
          Define custom AI behavior instructions for administrators
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-2">
              Custom System Instructions
            </label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Enter detailed instructions for how the AI should behave. For example: 'Always respond in a formal technical tone. When asked about security, defer to the security team. When discussing incidents, prioritize accuracy over speed.'"
              rows={8}
              className="font-mono text-sm"
            />
          </div>
          
          <div className="text-sm text-muted-foreground">
            <p className="mb-1">Example behaviors:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Formal technical tone</li>
              <li>Security-aware responses</li>
              <li>Incident-focused prioritization</li>
              <li>Documentation-ready responses</li>
            </ul>
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        {saveError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <span>{saveError}</span>
          </div>
        )}
        {saveSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />
            <span>Instructions saved successfully</span>
          </div>
        )}
        <Button 
          onClick={handleSave} 
          disabled={isSaving}
          className="flex items-center gap-2"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              Save Instructions
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
};

interface BehaviorSettingsPanelProps {
  initialBehaviorSettings: {
    responseMode?: 'knowledge_only' | 'knowledge_preferred' | 'model_only';
    knowledgeScope?: 'selected_collection' | 'all_collections';
    citationStyle?: 'inline' | 'sources_list' | 'inline_and_sources';
    noKnowledgeResponse?: string;
    maxSources?: number;
    minimumRelevanceScore?: number;
  };
  onSave: (settings: any) => Promise<void>;
  className?: string;
}

export const BehaviorSettingsPanel = ({ 
  initialBehaviorSettings,
  onSave,
  className = ''
}: BehaviorSettingsPanelProps) => {
  const [responseMode, setResponseMode] = useState(initialBehaviorSettings.responseMode || 'knowledge_only');
  const [knowledgeScope, setKnowledgeScope] = useState(initialBehaviorSettings.knowledgeScope || 'selected_collection');
  const [citationStyle, setCitationStyle] = useState(initialBehaviorSettings.citationStyle || 'inline_and_sources');
  const [noKnowledgeResponse, setNoKnowledgeResponse] = useState(initialBehaviorSettings.noKnowledgeResponse || '');
  const [maxSources, setMaxSources] = useState(initialBehaviorSettings.maxSources || 5);
  const [minimumRelevanceScore, setMinimumRelevanceScore] = useState(initialBehaviorSettings.minimumRelevanceScore || 0.55);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);
    
    try {
      await onSave({
        responseMode,
        knowledgeScope,
        citationStyle,
        noKnowledgeResponse,
        maxSources,
        minimumRelevanceScore
      });
      setSaveSuccess(true);
      // Reset success indicator after 3 seconds
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (error) {
      setSaveError('Failed to save behavior settings. Please try again.');
      console.error('Failed to save behavior settings:', error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Settings className="h-5 w-5 text-primary" />
          <CardTitle>Advanced Behavior Settings</CardTitle>
        </div>
        <CardDescription>
          Fine-tune AI response behavior and knowledge integration
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Response Mode
              </label>
              <select
                value={responseMode}
                onChange={(e) => setResponseMode(e.target.value as any)}
                className="w-full h-10 px-3 border border-input rounded-lg bg-background"
              >
                <option value="knowledge_only">Knowledge Only</option>
                <option value="knowledge_preferred">Knowledge Preferred</option>
                <option value="model_only">Model Only</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">
                Knowledge Scope
              </label>
              <select
                value={knowledgeScope}
                onChange={(e) => setKnowledgeScope(e.target.value as any)}
                className="w-full h-10 px-3 border border-input rounded-lg bg-background"
              >
                <option value="selected_collection">Selected Collection</option>
                <option value="all_collections">All Collections</option>
              </select>
            </div>
          </div>
          
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">
                Citation Style
              </label>
              <select
                value={citationStyle}
                onChange={(e) => setCitationStyle(e.target.value as any)}
                className="w-full h-10 px-3 border border-input rounded-lg bg-background"
              >
                <option value="inline">Inline Citations</option>
                <option value="sources_list">Sources List</option>
                <option value="inline_and_sources">Both</option>
              </select>
            </div>
            
            <div>
              <label className="block text-sm font-medium mb-2">
                Max Sources
              </label>
              <Input
                type="number"
                value={maxSources}
                onChange={(e) => setMaxSources(Number(e.target.value))}
                className="w-full"
              />
            </div>
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-2">
              Minimum Relevance Score
            </label>
            <Input
              type="number"
              step="0.01"
              value={minimumRelevanceScore}
              onChange={(e) => setMinimumRelevanceScore(Number(e.target.value))}
              className="w-full"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium mb-2">
              No Knowledge Response
            </label>
            <Textarea
              value={noKnowledgeResponse}
              onChange={(e) => setNoKnowledgeResponse(e.target.value)}
              placeholder="Message to show when no relevant knowledge is found..."
              rows={3}
            />
          </div>
        </div>
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        {saveError && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <span>{saveError}</span>
          </div>
        )}
        {saveSuccess && (
          <div className="flex items-center gap-2 text-sm text-green-600">
            <CheckCircle className="h-4 w-4" />
            <span>Behavior settings saved</span>
          </div>
        )}
        <Button 
          onClick={handleSave} 
          disabled={isSaving}
          className="flex items-center gap-2"
        >
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="h-4 w-4" />
              Save Behavior Settings
            </>
          )}
        </Button>
      </CardFooter>
    </Card>
  );
};