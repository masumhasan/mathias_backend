import bcrypt from 'bcryptjs';
import { User } from '../models/User';
import logger from '../utils/logger';

const SUPERADMIN_EMAIL = 'mathiasschulze@me.com';
const SUPERADMIN_PASSWORD = 'Test@123';

/**
 * Ensures the superadmin account always exists with admin access, without
 * touching its password once created — so a password reset/change by the
 * superadmin survives future server restarts instead of being overwritten.
 */
export async function seedSuperAdmin(): Promise<void> {
  const existing = await User.findOne({ email: SUPERADMIN_EMAIL });

  if (existing) {
    if (existing.role !== 'admin' || !existing.emailVerified) {
      existing.role = 'admin';
      existing.emailVerified = true;
      await existing.save();
      logger.info('Superadmin account upgraded to admin role', { email: SUPERADMIN_EMAIL });
    }
    return;
  }

  const passwordHash = await bcrypt.hash(SUPERADMIN_PASSWORD, 10);
  await User.create({
    email: SUPERADMIN_EMAIL,
    passwordHash,
    role: 'admin',
    firstName: 'Mathias',
    lastName: 'Schulze',
    emailVerified: true,
  });

  logger.info('Superadmin account created', { email: SUPERADMIN_EMAIL });
}
