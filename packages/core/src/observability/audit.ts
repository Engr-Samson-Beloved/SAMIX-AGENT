import fs from 'node:fs';
import path from 'node:path';
import type { AuditRecord } from '@samix/shared';
import { redact } from './redact.js';

/**
 * Append-only audit trail (spec §37).
 *
 * Kept separate from diagnostics on purpose. Diagnostic logs are for debugging
 * and get rotated, downsampled and filtered by level. The audit trail answers a
 * different, higher-stakes question — "what did this agent actually do to my
 * computer, and did I approve it?" — so it is never level-filtered and never
 * silently truncated.
 *
 * An audit record is written for every tool execution attempt, including ones
 * that were *blocked* or *denied*. A permission refusal is exactly the kind of
 * event a user auditing their machine wants to see.
 */
export class AuditTrail {
  private stream: fs.WriteStream | undefined;
  private enabled: boolean;

  constructor(
    private readonly auditFile: string,
    enabled = true,
  ) {
    this.enabled = enabled;
    if (enabled) this.open();
  }

  record(entry: AuditRecord): void {
    if (!this.enabled || !this.stream) return;
    // Inputs may carry paths, recipients and message text. Redaction applies
    // here exactly as it does to logs — the audit trail records *that* a
    // message was sent and to whom, not its private contents.
    const safe: AuditRecord = { ...entry, input: redact(entry.input) };
    try {
      this.stream.write(`${JSON.stringify(safe)}\n`);
    } catch (error) {
      process.stderr.write(`[audit] write failed: ${String(error)}\n`);
    }
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) this.open();
    else this.close();
  }

  close(): void {
    this.stream?.end();
    this.stream = undefined;
  }

  private open(): void {
    try {
      fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
      this.stream = fs.createWriteStream(this.auditFile, { flags: 'a' });
      this.stream.on('error', (error) => {
        process.stderr.write(`[audit] stream error: ${String(error)}\n`);
        this.stream = undefined;
      });
    } catch (error) {
      process.stderr.write(`[audit] cannot open audit file: ${String(error)}\n`);
    }
  }
}
