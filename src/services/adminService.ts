import { User } from '../models/User';
import { Conversation } from '../models/Conversation';
import { createError } from '../middleware/errorHandler';

export interface LegalAdviceClient {
  id: string;
  name: string;
  email: string;
  role: 'user' | 'client';
  emailVerified: boolean;
  banned: boolean;
  conversationCount: number;
  lastActive: Date | null;
  registeredAt: Date;
}

export interface LegalAdviceClientDetail extends LegalAdviceClient {
  phone?: string;
  country?: string;
  city?: string;
  bio?: string;
}

export interface UpdateClientInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  country?: string;
  city?: string;
  bio?: string;
}

async function attachActivity(
  users: { _id: { toString(): string }; firstName: string; lastName: string; email: string; role?: 'user' | 'admin' | 'client'; emailVerified: boolean; banned: boolean; createdAt: Date }[],
): Promise<LegalAdviceClient[]> {
  const activity = await Conversation.aggregate([
    {
      $group: {
        _id: '$userId',
        conversationCount: { $sum: 1 },
        lastActive: { $max: '$updatedAt' },
      },
    },
  ]);
  const activityByUserId = new Map(activity.map((a) => [a._id.toString(), a]));

  return users.map((user) => {
    const userActivity = activityByUserId.get(user._id.toString());
    return {
      id: user._id.toString(),
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      // Accounts created before `role` existed have no value stored at all —
      // those predate the 'client' role entirely, so they're 'user' accounts.
      role: user.role === 'client' ? 'client' : 'user',
      emailVerified: user.emailVerified,
      banned: user.banned,
      conversationCount: userActivity?.conversationCount ?? 0,
      lastActive: userActivity?.lastActive ?? null,
      registeredAt: user.createdAt,
    };
  });
}

/**
 * Only non-admin accounts are exposed here — this powers the "Legal Advise
 * Clients" admin screen, and admin accounts must never be editable/bannable/
 * deletable through it.
 */
// Accounts created before the `role` field existed have no `role` stored in
// the DB at all, so the schema default never applied — match those as 'user'
// too, rather than only documents with an explicit role: 'user'.
const NON_ADMIN_FILTER = { role: { $ne: 'admin' } };

export async function listLegalAdviceClients(): Promise<LegalAdviceClient[]> {
  const users = await User.find(NON_ADMIN_FILTER)
    .select('firstName lastName email role emailVerified banned createdAt')
    .sort({ createdAt: -1 })
    .lean();

  return attachActivity(users);
}

async function findClientOrThrow(id: string) {
  const user = await User.findOne({ _id: id, ...NON_ADMIN_FILTER });
  if (!user) throw createError('Client not found.', 404);
  return user;
}

export async function getLegalAdviceClient(id: string): Promise<LegalAdviceClientDetail> {
  const user = await findClientOrThrow(id);
  const [summary] = await attachActivity([user]);

  return {
    ...summary,
    phone: user.phone,
    country: user.country,
    city: user.city,
    bio: user.bio,
  };
}

export async function updateLegalAdviceClient(
  id: string,
  input: UpdateClientInput,
): Promise<LegalAdviceClientDetail> {
  const user = await findClientOrThrow(id);

  if (input.email !== undefined && input.email.toLowerCase().trim() !== user.email) {
    const email = input.email.toLowerCase().trim();
    const existing = await User.findOne({ email });
    if (existing) throw createError('Another account already uses this email.', 409);
    user.email = email;
  }
  if (input.firstName !== undefined) user.firstName = input.firstName;
  if (input.lastName !== undefined) user.lastName = input.lastName;
  if (input.phone !== undefined) user.phone = input.phone || undefined;
  if (input.country !== undefined) user.country = input.country || undefined;
  if (input.city !== undefined) user.city = input.city || undefined;
  if (input.bio !== undefined) user.bio = input.bio || undefined;

  await user.save();

  const [summary] = await attachActivity([user]);
  return {
    ...summary,
    phone: user.phone,
    country: user.country,
    city: user.city,
    bio: user.bio,
  };
}

export async function setLegalAdviceClientBanned(
  id: string,
  banned: boolean,
): Promise<LegalAdviceClientDetail> {
  const user = await findClientOrThrow(id);
  user.banned = banned;
  await user.save();

  const [summary] = await attachActivity([user]);
  return {
    ...summary,
    phone: user.phone,
    country: user.country,
    city: user.city,
    bio: user.bio,
  };
}

export async function deleteLegalAdviceClient(id: string): Promise<void> {
  const user = await findClientOrThrow(id);
  await Conversation.deleteMany({ userId: user._id });
  await user.deleteOne();
}

export interface ClientChatSummary {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  banned: boolean;
  registeredAt: Date;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
}

/**
 * Lists every 'client'-role user (the /client-chat portal) alongside their
 * single ongoing conversation's last message, for the admin "Client Chats" page.
 */
export async function listClientChats(): Promise<ClientChatSummary[]> {
  const users = await User.find({ role: 'client' })
    .select('firstName lastName email emailVerified banned createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const conversations = await Conversation.find({ kind: 'client' })
    .select('userId updatedAt messages')
    .lean();
  const conversationByUserId = new Map(conversations.map((c) => [c.userId.toString(), c]));

  return users.map((user) => {
    const conversation = conversationByUserId.get(user._id.toString());
    const lastMessage = conversation?.messages[conversation.messages.length - 1];
    return {
      id: user._id.toString(),
      name: `${user.firstName} ${user.lastName}`.trim(),
      email: user.email,
      emailVerified: user.emailVerified,
      banned: user.banned,
      registeredAt: user.createdAt,
      lastMessageAt: conversation?.updatedAt ?? null,
      lastMessagePreview: lastMessage?.content ?? null,
    };
  });
}

export async function getClientChatDetail(id: string) {
  const user = await User.findOne({ _id: id, role: 'client' })
    .select('firstName lastName email emailVerified banned createdAt')
    .lean();
  if (!user) throw createError('Client not found.', 404);

  const conversation = await Conversation.findOne({ userId: id, kind: 'client' })
    .sort({ updatedAt: -1 })
    .lean();

  return {
    id: user._id.toString(),
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    emailVerified: user.emailVerified,
    banned: user.banned,
    registeredAt: user.createdAt,
    conversation: conversation
      ? {
          id: conversation._id.toString(),
          updatedAt: conversation.updatedAt,
          messages: conversation.messages.map((m) => ({
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
        }
      : null,
  };
}
