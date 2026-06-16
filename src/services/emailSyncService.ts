import { ImapFlow } from 'imapflow';
import { simpleParser, AddressObject } from 'mailparser';
import { Email, IEmailAddress } from '../models/Email';
import { SyncState } from '../models/SyncState';
import { auditSystem } from './auditService';
import { getImapConfig } from '../config/imap';
import logger from '../utils/logger';

// ── Tuning constants ──────────────────────────────────────────────────────────
/** UIDs fetched per IMAP FETCH command. Keep small — iCloud resets connections on large bursts. */
const BATCH_SIZE = 10;
/** Pause between consecutive IMAP FETCH commands (ms). Prevents iCloud rate-limiting. */
const INTER_BATCH_DELAY_MS = 1_000;
/** Parallel parsers within each batch. */
const PARSE_CONCURRENCY = 8;
/** Max characters stored for the plain-text body. */
const MAX_TEXT_BODY = 20_000;
/** Terminal progress line is printed every N emails. */
const LOG_EVERY = 10;
/** Folders processed simultaneously. iCloud allows ≤ 5 connections. */
const MAX_CONCURRENT_FOLDERS = 2;
/** Retry attempts per folder before giving up. */
const MAX_FOLDER_ATTEMPTS = 3;
/** Base delay for exponential backoff between retries (ms). */
const RETRY_BASE_DELAY_MS = 5_000;
/** Only sync emails from this date forward. */
const SYNC_SINCE_DATE = new Date('2022-01-01');
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Convert HTML email body to plain text when no text/plain MIME part exists.
 * Preserves line breaks from block-level tags; strips all markup and decodes
 * common HTML entities. Good enough for LLM context — not a full HTML renderer.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/td>/gi, '  ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface RawMessage {
  uid: number;
  source: Buffer;
  flags: Set<string>;
}

interface EmailDoc {
  messageId: string;
  folder: string;
  uid: number;
  from: IEmailAddress[];
  to: IEmailAddress[];
  cc: IEmailAddress[];
  bcc: IEmailAddress[];
  replyTo: IEmailAddress[];
  subject: string;
  textBody: string;
  date: Date;
  inReplyTo?: string;
  references: string[];
  hasAttachments: boolean;
  attachments: { filename: string; contentType: string; size: number }[];
  participants: string[];
  flags: string[];
  syncedAt: Date;
}

class EmailSyncService {
  private isSyncing = false;

  get syncing(): boolean {
    return this.isSyncing;
  }

  async sync(): Promise<void> {
    if (this.isSyncing) {
      logger.warn('Email sync already in progress — skipping this run');
      return;
    }

    this.isSyncing = true;
    logger.info('Email sync started');
    await auditSystem('SYNC_STARTED', {});

    try {
      // ── Step 1: List mailboxes with a short-lived connection ──────────────
      const folders = await this.listMailboxes();
      logger.info(`Found ${folders.length} mailboxes to sync`);

      // ── Step 2: Sync each folder with its own connection (parallel, capped) ─
      await runWithConcurrency(folders, MAX_CONCURRENT_FOLDERS, (folder) =>
        this.syncFolderWithRetry(folder),
      );

      await auditSystem('SYNC_COMPLETED', { folders: folders.length });
      logger.info('Email sync completed');
    } catch (err) {
      const message = (err as Error).message;
      logger.error('Email sync failed', { error: message });
      await auditSystem('SYNC_ERROR', { error: message });
    } finally {
      this.isSyncing = false;
    }
  }

  /** Opens a temporary IMAP connection just to list mailbox paths. */
  private async listMailboxes(): Promise<string[]> {
    const client = new ImapFlow(getImapConfig());
    try {
      await client.connect();
      const mailboxes = await client.list();
      return mailboxes
        .filter((m) => !m.flags.has('\\Noselect'))
        .map((m) => m.path);
    } finally {
      try {
        await client.logout();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Syncs one folder, retrying up to MAX_FOLDER_ATTEMPTS times with
   * exponential backoff. Each attempt opens a fresh IMAP connection so a
   * dropped connection on one folder never affects others.
   */
  private async syncFolderWithRetry(folder: string): Promise<void> {
    for (let attempt = 1; attempt <= MAX_FOLDER_ATTEMPTS; attempt++) {
      const client = new ImapFlow(getImapConfig());

      // imapflow can emit 'error' events (e.g. ECONNRESET) in addition to throwing.
      // Without a listener Node treats unhandled error events as uncaught exceptions
      // and crashes the process, bypassing the retry logic entirely.
      client.on('error', (err: Error) => {
        logger.warn(`IMAP connection error on "${folder}": ${err.message}`);
      });

      try {
        await client.connect();
        await this.syncFolder(client, folder);
        return; // success — exit retry loop
      } catch (err) {
        const message = (err as Error).message;

        if (attempt < MAX_FOLDER_ATTEMPTS) {
          const delay = RETRY_BASE_DELAY_MS * attempt;
          logger.warn(
            `Folder "${folder}" attempt ${attempt}/${MAX_FOLDER_ATTEMPTS} failed — ` +
              `retrying in ${delay / 1000}s`,
            { error: message },
          );
          await sleep(delay);
        } else {
          logger.error(
            `Folder "${folder}" failed after ${MAX_FOLDER_ATTEMPTS} attempts`,
            { error: message },
          );
          await SyncState.findOneAndUpdate(
            { folder },
            { status: 'error', lastError: message },
            { upsert: true },
          );
          await auditSystem('SYNC_ERROR', { folder, error: message });
        }
      } finally {
        try {
          await client.logout();
        } catch {
          // ignore — connection may already be dead
        }
      }
    }
  }

  private async syncFolder(client: ImapFlow, folder: string): Promise<void> {
    let lock: { release: () => void } | null = null;

    try {
      lock = await client.getMailboxLock(folder);

      // ── 1. Get UIDs from 2022 onward (no content downloaded) ─────────────
      const searchResult = await client.search({ since: SYNC_SINCE_DATE }, { uid: true });
      const imapUids: number[] = searchResult === false ? [] : searchResult;

      if (!imapUids.length) {
        logger.info(`Folder "${folder}": empty on server`);
        return;
      }

      // ── 2. Check which UIDs we already have in MongoDB ────────────────────
      const existingUids: number[] = await Email.distinct('uid', { folder });
      const existingUidSet = new Set(existingUids);

      // ── 3. Diff — newest UIDs first ───────────────────────────────────────
      const newUids = imapUids
        .filter((uid) => !existingUidSet.has(uid))
        .sort((a, b) => b - a);

      logger.info(
        `Folder "${folder}": ${imapUids.length} on server, ` +
          `${existingUids.length} already in DB, ${newUids.length} to fetch`,
      );

      if (!newUids.length) {
        logger.info(`Folder "${folder}": up to date`);
        await SyncState.findOneAndUpdate(
          { folder },
          { lastSyncAt: new Date(), status: 'idle', $unset: { lastError: '' } },
          { upsert: true },
        );
        return;
      }

      await SyncState.findOneAndUpdate(
        { folder },
        { status: 'syncing' },
        { upsert: true, new: true },
      );

      let processed = 0;
      let errors = 0;
      const total = newUids.length;
      const folderStart = Date.now();
      let lastLoggedAt = 0;

      logger.info(`━━━ Syncing "${folder}" — ${total} new emails ━━━`);

      // ── 4. Fetch → parse → write, one batch at a time ────────────────────
      for (let i = 0; i < newUids.length; i += BATCH_SIZE) {
        const batchUids = newUids.slice(i, i + BATCH_SIZE);

        // 4a. Collect raw messages — minimal work so the stream drains fast
        const rawMessages: RawMessage[] = [];
        for await (const msg of client.fetch(
          batchUids.join(','),
          { source: true, uid: true, flags: true },
          { uid: true },
        )) {
          rawMessages.push({
            uid: msg.uid,
            source: msg.source as Buffer,
            flags: msg.flags as Set<string>,
          });
        }

        // 4b. Parse in parallel
        const docs = await parseBatch(rawMessages, folder);
        errors += rawMessages.length - docs.length;

        // 4c. Bulk write — one round-trip for the whole batch
        if (docs.length > 0) {
          await Email.bulkWrite(
            docs.map((doc) => ({
              updateOne: {
                filter: { messageId: doc.messageId },
                update: { $setOnInsert: doc },
                upsert: true,
              },
            })),
            { ordered: false },
          );
          processed += docs.length;
        }

        // 4d. Progress log every LOG_EVERY emails
        const done = processed + errors;
        if (Math.floor(done / LOG_EVERY) > Math.floor(lastLoggedAt / LOG_EVERY) || done === total) {
          lastLoggedAt = done;
          logProgress(folder, done, total, processed, errors, folderStart);
        }

        // 4e. Pause between batches — prevents iCloud from resetting the connection
        if (i + BATCH_SIZE < newUids.length) {
          await sleep(INTER_BATCH_DELAY_MS);
        }
      }

      const totalSec = ((Date.now() - folderStart) / 1000).toFixed(1);

      await SyncState.findOneAndUpdate(
        { folder },
        {
          lastSyncAt: new Date(),
          status: 'idle',
          $inc: { totalSynced: processed },
          $unset: { lastError: '' },
        },
        { upsert: true },
      );

      await auditSystem('SYNC_FOLDER_DONE', {
        folder,
        processed,
        errors,
        skipped: existingUids.length,
      });

      logger.info(
        `━━━ Done "${folder}": ✓ ${processed} synced  ✗ ${errors} errors  ` +
          `⏭ ${existingUids.length} skipped  ⏱ ${totalSec}s ━━━`,
      );
    } finally {
      lock?.release();
    }
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

/**
 * Worker-pool: runs `fn` on each item with at most `concurrency` running at once.
 * Errors from individual items are swallowed so one failure doesn't cancel others.
 */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];

  async function worker(): Promise<void> {
    let item: T | undefined;
    while ((item = queue.shift()) !== undefined) {
      await fn(item);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
}

/** Parses a batch of raw IMAP messages concurrently. */
async function parseBatch(messages: RawMessage[], folder: string): Promise<EmailDoc[]> {
  const results: (EmailDoc | null)[] = new Array<EmailDoc | null>(messages.length).fill(null);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < messages.length) {
      const idx = next++;
      results[idx] = await parseRawMessage(messages[idx], folder);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(PARSE_CONCURRENCY, messages.length) }, worker),
  );

  return results.filter((r): r is EmailDoc => r !== null);
}

async function parseRawMessage(msg: RawMessage, folder: string): Promise<EmailDoc | null> {
  try {
    const parsed = await simpleParser(msg.source);

    const from = extractAddresses(parsed.from);
    const to = extractAddresses(parsed.to);
    const cc = extractAddresses(parsed.cc);
    const bcc = extractAddresses(parsed.bcc);
    const replyTo = extractAddresses(parsed.replyTo);

    const participants = [
      ...new Set(
        [
          ...from.map((a) => a.address),
          ...to.map((a) => a.address),
          ...cc.map((a) => a.address),
          ...bcc.map((a) => a.address),
        ].filter(Boolean),
      ),
    ];

    const messageId =
      parsed.messageId?.trim() || `generated-${folder}-${msg.uid}-${Date.now()}`;

    const attachments = (parsed.attachments || []).map((att) => ({
      filename: att.filename || 'unknown',
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
    }));

    return {
      messageId,
      folder,
      uid: msg.uid,
      from,
      to,
      cc,
      bcc,
      replyTo,
      subject: parsed.subject || '(no subject)',
      textBody: (parsed.text || (parsed.html ? stripHtml(parsed.html) : '')).slice(0, MAX_TEXT_BODY),
      date: parsed.date || new Date(),
      inReplyTo: parsed.inReplyTo || undefined,
      references: Array.isArray(parsed.references)
        ? parsed.references
        : parsed.references
          ? [parsed.references]
          : [],
      hasAttachments: attachments.length > 0,
      attachments,
      participants,
      flags: [...msg.flags],
      syncedAt: new Date(),
    };
  } catch (err) {
    logger.warn(`  ✗ UID ${msg.uid} parse failed: ${(err as Error).message}`);
    return null;
  }
}

function logProgress(
  folder: string,
  done: number,
  total: number,
  synced: number,
  errors: number,
  startMs: number,
): void {
  const pct = Math.round((done / total) * 100);
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  const rate = done / ((Date.now() - startMs) / 1000);
  const remainingSec = rate > 0 ? Math.round((total - done) / rate) : 0;
  const eta =
    done >= total
      ? 'done'
      : remainingSec < 60
        ? `~${remainingSec}s`
        : `~${Math.ceil(remainingSec / 60)}m`;

  logger.info(
    `  [${folder}] ${done}/${total} (${pct}%) — ` +
      `✓ ${synced} synced  ✗ ${errors} errors  ` +
      `elapsed ${elapsedSec}s  ETA ${eta}`,
  );
}

function extractAddresses(
  field: AddressObject | AddressObject[] | undefined,
): IEmailAddress[] {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  return objects
    .flatMap((obj) => obj.value || [])
    .map((addr) => ({
      name: addr.name || undefined,
      address: (addr.address || '').toLowerCase().trim(),
    }))
    .filter((a) => a.address);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const emailSyncService = new EmailSyncService();
