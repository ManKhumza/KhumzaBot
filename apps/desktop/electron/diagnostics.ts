import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export interface DiagnosticEvent {
  timestamp: string;
  component: string;
  event: string;
  message: string;
  correlationId: string;
}

export function sanitizeDiagnostic(value: unknown, secrets: readonly string[] = []): string {
  let text = value instanceof Error ? value.message : String(value);
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text.replace(/(Bearer\s+)[^\s,"'}]+/gi, '$1[redacted]')
    .replace(/(["']?(?:password|passwd|token|secret|api[_-]?key|authorization|credential|content|prompt|message|body|input)["']?\s*[=:]\s*)('[^']*'|"[^"]*"|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\b[0-9a-f]{48,}\b/gi, '[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f]/g, '')
    .slice(0, 2048);
}

/** A fixed-size, local-only journal. No request bodies, environments, or user documents. */
export class DiagnosticJournal {
  readonly correlationId = randomUUID();
  readonly logPath: string;
  private recent: DiagnosticEvent[] = [];

  constructor(readonly directory: string, readonly version: string, private readonly secrets: () => readonly string[], private readonly maxBytes = 1024 * 1024) {
    mkdirSync(directory, { recursive: true });
    this.logPath = join(directory, 'desktop.jsonl');
    if (existsSync(this.logPath)) {
      const size = statSync(this.logPath).size;
      if (size <= maxBytes) {
        this.recent = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).slice(-100).flatMap(line => {
          try { return [JSON.parse(line) as DiagnosticEvent]; } catch { return []; }
        });
      }
    }
  }

  record(component: string, event: string, message: unknown): void {
    const entry: DiagnosticEvent = {
      timestamp: new Date().toISOString(), component, event,
      message: sanitizeDiagnostic(message, this.secrets()), correlationId: this.correlationId,
    };
    const line = JSON.stringify({ ...entry, version: this.version }) + '\n';
    if (existsSync(this.logPath) && statSync(this.logPath).size + Buffer.byteLength(line) > this.maxBytes) {
      const oldest = this.logPath + '.2';
      if (existsSync(oldest)) unlinkSync(oldest);
      if (existsSync(this.logPath + '.1')) renameSync(this.logPath + '.1', oldest);
      renameSync(this.logPath, this.logPath + '.1');
    }
    appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 });
    this.recent.push(entry);
    if (this.recent.length > 100) this.recent.shift();
  }

  snapshot(): DiagnosticEvent[] {
    return this.recent.map(entry => ({ ...entry, message: sanitizeDiagnostic(entry.message, this.secrets()) }));
  }

  exportTo(path: string, diagnostics: unknown): void {
    writeFileSync(path, JSON.stringify(diagnostics, null, 2), { encoding: 'utf8', mode: 0o600 });
  }
}
