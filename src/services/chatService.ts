import { Types } from 'mongoose';
import { ChatSession, IChatSession } from '../models/ChatSession';
import { Email, IEmail } from '../models/Email';

// Lean queries strip Mongoose internals; these aliases keep type safety without Document overhead
type LeanEmail = Omit<IEmail, keyof import('mongoose').Document> & { _id: Types.ObjectId };
type LeanSession = Omit<IChatSession, keyof import('mongoose').Document> & { _id: Types.ObjectId };
import { getOpenAIClient, OPENAI_MODEL } from '../config/openai';
import { CLIENT_CHAT_SYSTEM_PROMPT } from '../config/prompts/clientChatPrompt';
import logger from '../utils/logger';

const MAX_CONTEXT_EMAILS = 15;
const ALWAYS_RECENT = 5;   // newest emails always included — anchors follow-up questions
const TEXT_SEARCH_MAX = 10; // additional topically relevant emails from text search
const MAX_BODY_DEFAULT = 1_500;
const MAX_BODY_FULL_REQUEST = 8_000; // user explicitly asked for full email content
const MAX_HISTORY_MESSAGES = 10;

/** Detect what the user actually wants so we can tune the retrieval. */
function detectIntent(query: string): { wantsSent: boolean; wantsFullBody: boolean } {
  const q = query.toLowerCase();
  const wantsSent = /\b(i sent|sent by me|from me|i wrote|i emailed|emails? i (have )?sent|outgoing)\b/.test(q);
  const wantsFullBody = /\b(full|entire|complete|whole|exact|verbatim|type (out|in)?|write out|print|show me the (full|entire|complete|whole)|reproduce)\b/.test(q);
  return { wantsSent, wantsFullBody };
}

export interface CreateSessionResult {
  sessionId: string;
  userEmail: string;
  emailCount: number;
}

export interface ChatResult {
  response: string;
  emailsUsed: number;
}

export async function createSession(
  userEmail: string,
  ipAddress: string,
  userAgent: string,
): Promise<CreateSessionResult | null> {
  const normalized = userEmail.toLowerCase().trim();

  const emailCount = await Email.countDocuments({ participants: normalized });
  if (emailCount === 0) return null;

  const session = await ChatSession.create({
    userEmail: normalized,
    messages: [],
    ipAddress,
    userAgent,
    lastActiveAt: new Date(),
  });

  return { sessionId: session.id as string, userEmail: normalized, emailCount };
}

export interface GroundedHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Core email-grounded reply generation, shared by the legacy anonymous
 * ChatSession flow and the authenticated /client-chat conversation flow.
 */
export async function generateGroundedReply(
  userEmail: string,
  userMessage: string,
  history: GroundedHistoryMessage[],
): Promise<ChatResult> {
  const intent = detectIntent(userMessage);
  const emails = await findRelevantEmails(userEmail, userMessage, intent.wantsSent);
  const context = buildEmailContext(emails as unknown as IEmail[], userEmail, intent.wantsFullBody);

  const historyMessages = history.slice(-MAX_HISTORY_MESSAGES);

  const openai = getOpenAIClient();

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    max_tokens: intent.wantsFullBody ? 4000 : 1200,
    messages: [
      { role: 'system', content: CLIENT_CHAT_SYSTEM_PROMPT },
      ...historyMessages,
      {
        role: 'user',
        content: buildUserPrompt(context, userMessage),
      },
    ],
  });

  const assistantContent = completion.choices[0]?.message?.content ?? 'No response generated.';

  logger.info('Chat response generated', {
    userEmail,
    emailsUsed: emails.length,
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
  });

  return { response: assistantContent, emailsUsed: emails.length };
}

export async function sendMessage(
  sessionId: string,
  userMessage: string,
): Promise<ChatResult | null> {
  const session = await ChatSession.findById(sessionId);
  if (!session) return null;

  const historyMessages = session.messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

  const result = await generateGroundedReply(session.userEmail, userMessage, historyMessages);

  session.messages.push({ role: 'user', content: userMessage, timestamp: new Date() });
  session.messages.push({ role: 'assistant', content: result.response, timestamp: new Date() });
  session.lastActiveAt = new Date();
  await session.save();

  return result;
}

export async function getSessionHistory(
  sessionId: string,
): Promise<LeanSession | null> {
  return ChatSession.findById(sessionId).lean() as Promise<LeanSession | null>;
}

async function findRelevantEmails(
  userEmail: string,
  query: string,
  wantsSent: boolean,
): Promise<LeanEmail[]> {
  const trimmedQuery = query.trim();

  const baseFilter = wantsSent
    ? { 'from.address': new RegExp(`^${userEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    : { participants: userEmail };

  // ── Tier 1: always fetch the N most recent emails ────────────────────────────
  // This anchors follow-up questions to the same conversation thread the user
  // was just discussing, regardless of what the text search returns.
  const recentPromise = Email.find(baseFilter)
    .sort({ date: -1 })
    .limit(ALWAYS_RECENT)
    .lean();

  // ── Tier 2: text search for topically relevant emails ────────────────────────
  // Only run if there are meaningful non-stopword terms in the query.
  const stopwords = new Set([
    'the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'is',
    'are', 'was', 'that', 'this', 'with', 'i', 'me', 'my', 'you', 'it', 'type',
    'full', 'last', 'email', 'sent', 'send', 'write', 'show', 'get', 'give',
    'tell', 'what', 'how', 'when', 'where', 'which', 'who', 'from', 'by', 'out',
    'have', 'has', 'had', 'do', 'did', 'will', 'would', 'can', 'could', 'please',
    'entire', 'complete', 'whole', 'exact', 'print', 'english', 'german', 'french',
    'into', 'latest', 'recent', 'new', 'old', 'first', 'second', 'third', 'number',
    'are', 'the', 'status', 'case', 'about', 'any', 'all', 'not', 'more', 'also',
  ]);
  const meaningfulTerms = trimmedQuery
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !stopwords.has(t));

  let textResults: LeanEmail[] = [];
  if (meaningfulTerms.length > 0) {
    try {
      textResults = (await Email.find(
        { ...baseFilter, $text: { $search: meaningfulTerms.join(' ') } },
        { score: { $meta: 'textScore' } },
      )
        .sort({ score: { $meta: 'textScore' }, date: -1 })
        .limit(TEXT_SEARCH_MAX)
        .lean()) as unknown as LeanEmail[];

      logger.info(`findRelevantEmails: text search returned ${textResults.length} results`, {
        userEmail,
        wantsSent,
        terms: meaningfulTerms,
      });
    } catch (err) {
      logger.warn('findRelevantEmails: text search error', {
        userEmail,
        error: (err as Error).message,
      });
    }
  }

  const recentResults = (await recentPromise) as unknown as LeanEmail[];

  // ── Merge: recent first (anchor), then text results (topical), deduped ───────
  const seen = new Set<string>();
  const combined: LeanEmail[] = [];
  for (const e of [...recentResults, ...textResults]) {
    const id = String(e._id);
    if (!seen.has(id)) {
      seen.add(id);
      combined.push(e);
    }
  }

  // Re-sort by date descending so EMAIL 1 is always the newest in the context
  combined.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  logger.info(
    `findRelevantEmails: combined ${combined.length} emails (${recentResults.length} recent + ${textResults.length} text, deduped)`,
    { userEmail, wantsSent },
  );

  return combined.slice(0, MAX_CONTEXT_EMAILS);
}

function buildEmailContext(emails: IEmail[], userEmail: string, wantsFullBody: boolean): string {
  if (!emails.length) return 'No relevant emails found in the records.';

  const bodyLimit = wantsFullBody ? MAX_BODY_FULL_REQUEST : MAX_BODY_DEFAULT;

  return emails
    .map((email, idx) => {
      const fromAddresses = email.from.map((a) => a.address.toLowerCase());
      const direction = fromAddresses.includes(userEmail.toLowerCase()) ? 'SENT BY CLIENT' : 'RECEIVED BY CLIENT';

      const from = email.from.map((a) => formatAddress(a)).join(', ');
      const to = email.to.map((a) => a.address).join(', ');
      const cc = email.cc.length ? `CC: ${email.cc.map((a) => a.address).join(', ')}\n` : '';
      const body = (email.textBody ?? '').slice(0, bodyLimit);
      const truncated = (email.textBody ?? '').length > bodyLimit ? '\n[... body truncated ...]' : '';

      const bodySection = body
        ? `${body}${truncated}`
        : '[Email body not stored — HTML-only email synced before text extraction was enabled. Use subject line and metadata above for context.]';

      return `--- EMAIL ${idx + 1} [${direction}] ---
Date: ${email.date.toUTCString()}
From: ${from}
To: ${to}
${cc}Subject: ${email.subject}
---
${bodySection}
---`;
    })
    .join('\n\n');
}

function buildUserPrompt(emailContext: string, question: string): string {
  return `RELEVANT EMAIL RECORDS (sorted newest first — EMAIL 1 is the most recent):

${emailContext}

---

INSTRUCTION: The conversation history above shows what was previously discussed. If this is a follow-up question (e.g. "what are those documents?", "tell me more", "which one?"), first check the conversation history to identify which email or topic is being referenced, then answer using that specific email from the records above. Do not switch to a different email unless the question explicitly asks about a different topic.

QUESTION: ${question}`;
}

function formatAddress(a: { name?: string; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}
