import rateLimit from 'express-rate-limit';
import { Request, Response } from 'express';
import { audit } from '../services/auditService';

const rateLimitHandler = (req: Request, res: Response): void => {
  void audit('RATE_LIMIT_EXCEEDED', req, { details: { path: req.path } });
  res.status(429).json({
    error: 'Too many requests. Please wait before trying again.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

export const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
  keyGenerator: (req) => {
    const forwarded = req.headers['x-forwarded-for'];
    return Array.isArray(forwarded)
      ? forwarded[0]
      : (forwarded?.split(',')[0].trim() ?? req.socket.remoteAddress ?? 'unknown');
  },
});

export const sessionLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const authLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});

export const otpLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: rateLimitHandler,
});
