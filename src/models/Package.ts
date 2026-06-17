import mongoose, { Schema, Document } from 'mongoose';

export interface IPackage extends Document {
  name: string;
  price: number;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

const PackageSchema = new Schema<IPackage>(
  {
    name: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

export const Package = mongoose.model<IPackage>('Package', PackageSchema);
