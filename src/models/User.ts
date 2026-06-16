import mongoose, { Schema, Document } from 'mongoose';

export type UserRole = 'user' | 'admin' | 'client';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  firstName: string;
  lastName: string;
  phone?: string;
  country?: string;
  city?: string;
  bio?: string;
  emailVerified: boolean;
  banned: boolean;
  otpCode?: string;
  otpExpiresAt?: Date;
  otpAttempts: number;
  resetOtpCode?: string;
  resetOtpExpiresAt?: Date;
  resetOtpAttempts: number;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin', 'client'], default: 'user', required: true },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    phone: { type: String, trim: true },
    country: { type: String, trim: true },
    city: { type: String, trim: true },
    bio: { type: String, trim: true, maxlength: 1000 },
    emailVerified: { type: Boolean, default: false },
    banned: { type: Boolean, default: false },
    otpCode: { type: String },
    otpExpiresAt: { type: Date },
    otpAttempts: { type: Number, default: 0 },
    resetOtpCode: { type: String },
    resetOtpExpiresAt: { type: Date },
    resetOtpAttempts: { type: Number, default: 0 },
  },
  { timestamps: true },
);

export const User = mongoose.model<IUser>('User', UserSchema);
