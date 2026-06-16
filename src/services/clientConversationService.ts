import { Conversation } from '../models/Conversation';
import { User } from '../models/User';
import { generateGroundedReply } from './chatService';
import { createError } from '../middleware/errorHandler';

export interface ConversationDetail {
  id: string;
  title: string;
  updatedAt: Date;
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

function toDetail(conversation: {
  id?: string;
  title: string;
  updatedAt: Date;
  messages: { role: 'user' | 'assistant'; content: string; timestamp: Date }[];
}): ConversationDetail {
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

/**
 * Clients have a single ongoing thread (unlike the multi-conversation
 * /legalchat sidebar) — this finds it or creates an empty one.
 */
export async function getOrCreateConversation(userId: string): Promise<ConversationDetail> {
  let conversation = await Conversation.findOne({ userId, kind: 'client' }).sort({ updatedAt: -1 });
  if (!conversation) {
    conversation = await Conversation.create({ userId, kind: 'client', title: 'Client Conversation', messages: [] });
  }
  return toDetail(conversation);
}

export async function sendMessageInConversation(
  userId: string,
  message: string,
): Promise<SendMessageResult> {
  const user = await User.findById(userId).select('email');
  if (!user) throw createError('User not found.', 404);

  let conversation = await Conversation.findOne({ userId, kind: 'client' }).sort({ updatedAt: -1 });
  if (!conversation) {
    conversation = await Conversation.create({ userId, kind: 'client', title: 'Client Conversation', messages: [] });
  }

  const isFirstMessage = conversation.messages.length === 0;
  const history = conversation.messages.map((m) => ({ role: m.role, content: m.content }));

  const result = await generateGroundedReply(user.email, message, history);

  conversation.messages.push({ role: 'user', content: message, timestamp: new Date() });
  conversation.messages.push({ role: 'assistant', content: result.response, timestamp: new Date() });
  if (isFirstMessage) conversation.title = deriveTitle(message);

  await conversation.save();

  return { response: result.response, title: conversation.title, updatedAt: conversation.updatedAt };
}

export async function getClientChatTranscript(userId: string): Promise<ConversationDetail | null> {
  const conversation = await Conversation.findOne({ userId, kind: 'client' }).sort({ updatedAt: -1 });
  return conversation ? toDetail(conversation) : null;
}
