import mongoose, { Schema, Document } from 'mongoose';

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface ISyncState extends Document {
  folder: string;
  lastSyncAt?: Date;
  lastSyncedUid: number;
  totalSynced: number;
  status: SyncStatus;
  lastError?: string;
  updatedAt: Date;
}

const SyncStateSchema = new Schema<ISyncState>(
  {
    folder: { type: String, required: true, unique: true },
    lastSyncAt: Date,
    lastSyncedUid: { type: Number, default: 0 },
    totalSynced: { type: Number, default: 0 },
    status: { type: String, enum: ['idle', 'syncing', 'error'], default: 'idle' },
    lastError: String,
  },
  { timestamps: true },
);

export const SyncState = mongoose.model<ISyncState>('SyncState', SyncStateSchema);
