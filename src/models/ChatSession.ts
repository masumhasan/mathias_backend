import mongoose, { Schema, Document } from 'mongoose';

export type MessageRole = 'user' | 'assistant';

export interface IMessage {
  role: MessageRole;
  content: string;
  timestamp: Date;
}

export interface IChatSession extends Document {
  userEmail: string;
  messages: IMessage[];
  ipAddress: string;
  userAgent: string;
  lastActiveAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ChatSessionSchema = new Schema<IChatSession>(
  {
    userEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    messages: [MessageSchema],
    ipAddress: { type: String, required: true },
    userAgent: { type: String, default: '' },
    lastActiveAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Sessions expire after 24 hours of inactivity
ChatSessionSchema.index({ lastActiveAt: 1 }, { expireAfterSeconds: 86400 });

export const ChatSession = mongoose.model<IChatSession>('ChatSession', ChatSessionSchema);
