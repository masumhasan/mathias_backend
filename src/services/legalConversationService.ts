import { Conversation } from '../models/Conversation';
import { User } from '../models/User';
import { sendLegalChatMessage } from './legalChatService';
import { createError } from '../middleware/errorHandler';

const CONVERSATION_LIMITS: Record<string, number> = {
  silver: 3,
  gold: 10,
  platinum: Infinity,
};

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

export interface ConversationDetail extends ConversationSummary {
  messages: { role: 'user' | 'assistant'; content: string; timestamp: Date }[];
}

export interface SendMessageResult {
  response: string;
  title: string;
  updatedAt: Date;
}

function deriveTitle(message: string): string {
  const trimmed = message.trim().replace(/\s+/g, ' ');
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

// Conversations created before `kind` existed have no value stored in the DB
// at all — treat those as 'legal' rather than only matching an explicit value.
const LEGAL_FILTER = { kind: { $ne: 'client' } };

export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  const conversations = await Conversation.find({ userId, ...LEGAL_FILTER })
    .sort({ updatedAt: -1 })
    .select('title updatedAt')
    .lean();

  return conversations.map((c) => ({
    id: c._id.toString(),
    title: c.title,
    updatedAt: c.updatedAt,
  }));
}

export async function createConversation(userId: string): Promise<ConversationSummary> {
  const user = await User.findById(userId).select('subscriptionPlan').lean();
  const plan = user?.subscriptionPlan ?? 'none';

  if (plan === 'none') {
    throw createError('SUBSCRIPTION_REQUIRED', 402);
  }

  const limit = CONVERSATION_LIMITS[plan] ?? 0;
  if (isFinite(limit)) {
    const count = await Conversation.countDocuments({ userId, ...LEGAL_FILTER });
    if (count >= limit) {
      const upgradeTarget = plan === 'silver' ? 'gold' : null;
      const msg = upgradeTarget
        ? `CONVERSATION_LIMIT:${plan}:${limit}:${upgradeTarget}`
        : `CONVERSATION_LIMIT:${plan}:${limit}:none`;
      throw createError(msg, 403);
    }
  }

  const conversation = await Conversation.create({ userId, kind: 'legal', title: 'New Consultation', messages: [] });
  return { id: conversation.id as string, title: conversation.title, updatedAt: conversation.updatedAt };
}

export async function deleteConversation(userId: string, conversationId: string): Promise<void> {
  const result = await Conversation.deleteOne({ _id: conversationId, userId, ...LEGAL_FILTER });
  if (result.deletedCount === 0) throw createError('Conversation not found.', 404);
}

export async function getConversation(userId: string, conversationId: string): Promise<ConversationDetail> {
  const conversation = await Conversation.findOne({ _id: conversationId, userId, ...LEGAL_FILTER });
  if (!conversation) throw createError('Conversation not found.', 404);

  return {
    id: conversation.id as string,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    messages: conversation.messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    })),
  };
}

export async function sendMessageInConversation(
  userId: string,
  conversationId: string,
  message: string,
): Promise<SendMessageResult> {
  const conversation = await Conversation.findOne({ _id: conversationId, userId, ...LEGAL_FILTER });
  if (!conversation) throw createError('Conversation not found.', 404);

  const isFirstMessage = conversation.messages.length === 0;
  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }));

  const response = await sendLegalChatMessage(message, history);

  conversation.messages.push({ role: 'user', content: message, timestamp: new Date() });
  conversation.messages.push({ role: 'assistant', content: response, timestamp: new Date() });
  if (isFirstMessage) conversation.title = deriveTitle(message);

  await conversation.save();

  return { response, title: conversation.title, updatedAt: conversation.updatedAt };
}
