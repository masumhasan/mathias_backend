import mongoose, { Schema, Document } from 'mongoose';

export interface IEmailAddress {
  name?: string;
  address: string;
}

export interface IAttachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface IEmail extends Document {
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
  attachments: IAttachment[];
  /** Denormalized set of all participant email addresses (lowercase) for O(1) lookup */
  participants: string[];
  flags: string[];
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EmailAddressSchema = new Schema<IEmailAddress>(
  { name: String, address: { type: String, required: true } },
  { _id: false },
);

const AttachmentSchema = new Schema<IAttachment>(
  { filename: String, contentType: String, size: Number },
  { _id: false },
);

const EmailSchema = new Schema<IEmail>(
  {
    messageId: { type: String, required: true, unique: true },
    folder: { type: String, required: true },
    uid: { type: Number, required: true },
    from: [EmailAddressSchema],
    to: [EmailAddressSchema],
    cc: [EmailAddressSchema],
    bcc: [EmailAddressSchema],
    replyTo: [EmailAddressSchema],
    subject: { type: String, default: '' },
    textBody: { type: String, default: '' },
    date: { type: Date, required: true },
    inReplyTo: String,
    references: [String],
    hasAttachments: { type: Boolean, default: false },
    attachments: [AttachmentSchema],
    participants: [{ type: String, lowercase: true }],
    flags: [String],
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// Primary query pattern: find emails for a participant, sorted by date
EmailSchema.index({ participants: 1, date: -1 });

// Full-text search on subject and body
EmailSchema.index(
  { subject: 'text', textBody: 'text' },
  { weights: { subject: 5, textBody: 1 }, name: 'email_text_search' },
);

// Sync deduplication: folder + uid must be unique
EmailSchema.index({ folder: 1, uid: 1 }, { unique: true });

// Date index for range queries
EmailSchema.index({ date: -1 });

export const Email = mongoose.model<IEmail>('Email', EmailSchema);
