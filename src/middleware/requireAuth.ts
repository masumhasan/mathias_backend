import { Request, Response, NextFunction } from 'express';
import { verifyAuthToken } from '../services/authService';
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

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    next(createError('Authentication required.', 401));
    return;
  }

  try {
    const payload = verifyAuthToken(token);
    req.userId = payload.userId;
    req.userEmail = payload.email;
    next();
  } catch {
    next(createError('Invalid or expired session. Please log in again.', 401));
  }
}
