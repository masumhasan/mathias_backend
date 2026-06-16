import { Request, Response, NextFunction } from 'express';
import { verifyAuthToken } from '../services/authService';
import { User } from '../models/User';
import { createError } from './errorHandler';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      userEmail?: string;
    }
  }
}

export async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    next(createError('Authentication required.', 401));
    return;
  }

  try {
    const payload = verifyAuthToken(token);

    // Checked against the DB (not just the JWT) so a ban takes effect on an
    // already-issued session immediately, instead of waiting for it to expire.
    const user = await User.findById(payload.userId).select('banned');
    if (!user) {
      next(createError('Invalid or expired session. Please log in again.', 401));
      return;
    }
    if (user.banned) {
      next(createError('This account has been suspended. Please contact support.', 403, 'ACCOUNT_BANNED'));
      return;
    }

    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    next(createError('Invalid or expired session. Please log in again.', 401));
  }
}
