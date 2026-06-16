import { Request, Response, NextFunction } from 'express';
import { User } from '../models/User';
import { createError, asyncHandler } from './errorHandler';

/**
 * Must run after requireAuth — re-checks the user's role against the database
 * on every request (rather than trusting the JWT) so a demoted admin loses
 * dashboard access immediately, without waiting for their token to expire.
 */
export const requireAdmin = asyncHandler(
  async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = await User.findById(req.userId).select('role');
    if (!user || user.role !== 'admin') {
      throw createError('Admin access required.', 403);
    }
    next();
  },
);
