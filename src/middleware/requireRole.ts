import { Request, Response, NextFunction } from 'express';
import { User, UserRole } from '../models/User';
import { createError, asyncHandler } from './errorHandler';

export function requireRole(role: UserRole) {
  return asyncHandler(async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = await User.findById(req.userId).select('role');
    // Accounts created before `role` existed have no value stored in the DB at
    // all (the schema default never retroactively applied) — treat those as 'user'.
    const effectiveRole = user?.role ?? 'user';
    if (!user || effectiveRole !== role) {
      throw createError('You do not have access to this resource.', 403);
    }
    next();
  });
}
