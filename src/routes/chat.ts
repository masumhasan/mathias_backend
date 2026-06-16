import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { createSession, sendMessage, getSessionHistory } from '../services/chatService';
import { audit } from '../services/auditService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { chatLimiter, sessionLimiter } from '../middleware/rateLimiter';
import logger from '../utils/logger';

const router = Router();

const CreateSessionSchema = z.object({
  email: z.string().email('Invalid email address').max(254).toLowerCase().trim(),
});

const SendMessageSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message too long (max 2000 characters)')
    .trim(),
});

/**
 * POST /api/chat/sessions
 * Validates the user email and creates a new chat session.
 */
router.post(
  '/sessions',
  sessionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = CreateSessionSchema.parse(req.body);
    const ip = getClientIp(req);
    const ua = req.headers['user-agent'] || '';

    const result = await createSession(email, ip, ua);

    if (!result) {
      await audit('SESSION_EMAIL_NOT_FOUND', req, {
        userEmail: email,
        details: { reason: 'No emails found for this address' },
      });
      throw createError(
        'No email records found for this address. Please check the email and try again.',
        404,
      );
    }

    await audit('SESSION_CREATED', req, {
      userEmail: email,
      sessionId: result.sessionId,
      details: { emailCount: result.emailCount },
    });

    logger.info('Chat session created', { userEmail: email, emailCount: result.emailCount });

    res.status(201).json({
      sessionId: result.sessionId,
      userEmail: result.userEmail,
      emailCount: result.emailCount,
      message: `Found ${result.emailCount} email records for your address.`,
    });
  }),
);

/**
 * POST /api/chat/sessions/:sessionId/messages
 * Sends a user message and returns the AI-generated response.
 */
router.post(
  '/sessions/:sessionId/messages',
  chatLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const { message } = SendMessageSchema.parse(req.body);

    await audit('CHAT_QUERY', req, {
      sessionId,
      details: { queryLength: message.length },
    });

    const result = await sendMessage(sessionId, message);

    if (!result) {
      throw createError('Session not found or has expired. Please start a new session.', 404);
    }

    await audit('CHAT_RESPONSE', req, {
      sessionId,
      details: { emailsUsed: result.emailsUsed },
    });

    res.json({
      response: result.response,
      emailsUsed: result.emailsUsed,
    });
  }),
);

/**
 * GET /api/chat/sessions/:sessionId
 * Returns the message history for a session.
 */
router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;
    const session = await getSessionHistory(sessionId);

    if (!session) {
      throw createError('Session not found or has expired.', 404);
    }

    res.json({
      sessionId,
      userEmail: session.userEmail,
      messages: session.messages,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
    });
  }),
);

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export default router;
