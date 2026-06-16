import mongoose, { Schema, Document } from 'mongoose';

export type AuditEventType =
  | 'SESSION_CREATED'
  | 'SESSION_ENDED'
  | 'SESSION_EMAIL_NOT_FOUND'
  | 'PROFILE_UPDATED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET_REQUESTED'
  | 'PASSWORD_RESET_COMPLETED'
  | 'CHAT_QUERY'
  | 'CHAT_RESPONSE'
  | 'CHAT_ERROR'
  | 'LEGAL_CHAT_QUERY'
  | 'LEGAL_CHAT_RESPONSE'
  | 'CLIENT_CHAT_QUERY'
  | 'CLIENT_CHAT_RESPONSE'
  | 'SYNC_STARTED'
  | 'SYNC_COMPLETED'
  | 'SYNC_FOLDER_DONE'
  | 'SYNC_ERROR'
  | 'RATE_LIMIT_EXCEEDED'
  | 'VALIDATION_ERROR';

export interface IAuditLog extends Document {
  eventType: AuditEventType;
  userEmail?: string;
  sessionId?: string;
  ipAddress: string;
  userAgent?: string;
  details: Record<string, unknown>;
  timestamp: Date;
}

const AuditLogSchema = new Schema<IAuditLog>(
  {
    eventType: { type: String, required: true, index: true },
    userEmail: { type: String, lowercase: true, index: true },
    sessionId: { type: String, index: true },
    ipAddress: { type: String, required: true },
    userAgent: String,
    details: { type: Schema.Types.Mixed, default: {} },
    timestamp: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

// Audit logs retained for 90 days
AuditLogSchema.index({ timestamp: 1 }, { expireAfterSeconds: 7776000 });

// Compound index for querying by user + time range
AuditLogSchema.index({ userEmail: 1, timestamp: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
