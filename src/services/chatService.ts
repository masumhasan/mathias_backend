import { Types } from 'mongoose';
import { ChatSession, IChatSession } from '../models/ChatSession';
import { Email, IEmail } from '../models/Email';

// Lean queries strip Mongoose internals; these aliases keep type safety without Document overhead
type LeanEmail = Omit<IEmail, keyof import('mongoose').Document> & { _id: Types.ObjectId };
type LeanSession = Omit<IChatSession, keyof import('mongoose').Document> & { _id: Types.ObjectId };
import { getOpenAIClient, OPENAI_MODEL } from '../config/openai';
import { CLIENT_CHAT_SYSTEM_PROMPT } from '../config/prompts/clientChatPrompt';
import logger from '../utils/logger';

// Fetch the last 10 emails chronologically so the AI can follow the case
// progression step by step, matching the attorney's training data approach.
const MAX_CONTEXT_EMAILS = 10;
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

/**
 * Fetches the last MAX_CONTEXT_EMAILS emails where the client's email is a
 * participant, sorted chronologically (oldest→newest) so the AI can follow
 * the case progression step by step — matching the attorney training data approach.
 * When the client asks only about emails they sent, the filter narrows to outgoing mail.
 */
async function findRelevantEmails(
  userEmail: string,
  _query: string,
  wantsSent: boolean,
): Promise<LeanEmail[]> {
  const baseFilter = wantsSent
    ? { 'from.address': new RegExp(`^${userEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
    : { participants: userEmail };

  // Fetch newest first so we always get the most recent 10, then reverse to
  // chronological order before passing to the AI.
  const emails = (await Email.find(baseFilter)
    .sort({ date: -1 })
    .limit(MAX_CONTEXT_EMAILS)
    .lean()) as unknown as LeanEmail[];

  // Oldest→newest: EMAIL 1 = oldest context, last email = current case status
  emails.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  logger.info(`findRelevantEmails: fetched ${emails.length} emails (chronological)`, {
    userEmail,
    wantsSent,
  });

  return emails;
}

function buildEmailContext(emails: IEmail[], userEmail: string, wantsFullBody: boolean): string {
  if (!emails.length) return 'No email records found for this client.';

  const bodyLimit = wantsFullBody ? MAX_BODY_FULL_REQUEST : MAX_BODY_DEFAULT;
  const total = emails.length;

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

      // Label the last email explicitly as the most recent so the AI can anchor status answers
      const recencyLabel = idx === total - 1 ? ' — MOST RECENT' : '';

      return `--- EMAIL ${idx + 1}${recencyLabel} [${direction}] ---
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
  return `CLIENT EMAIL RECORDS (sorted oldest→newest — read in order to follow the case progression; the last email marked MOST RECENT is the current case status):

${emailContext}

---

INSTRUCTION: Read the emails above in sequence to understand the case progression before answering. For "what is the status" or "what happened" questions, anchor the answer on the MOST RECENT email, then use earlier emails for background. If this is a follow-up question (e.g. "what are those documents?", "tell me more", "which one?"), check the conversation history to identify which email or topic was being discussed, then answer from that specific email — do not switch to a different email unless the question explicitly asks about a different topic.

QUESTION: ${question}`;
}

function formatAddress(a: { name?: string; address: string }): string {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}
