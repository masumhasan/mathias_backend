import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
  getOrCreateConversation,
  sendMessageInConversation,
} from '../services/clientConversationService';
import { audit } from '../services/auditService';
import { asyncHandler } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { chatLimiter } from '../middleware/rateLimiter';

const router = Router();

router.use(requireAuth, requireRole('client'));

const SendMessageSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message too long (max 2000 characters)')
    .trim(),
});

/**
 * GET /api/client-chat/conversation
 * Returns the client's single ongoing conversation, creating it if needed.
 */
router.get(
  '/conversation',
  asyncHandler(async (req: Request, res: Response) => {
    const conversation = await getOrCreateConversation(req.userId as string);
    res.json({ conversation });
  }),
);

/**
 * POST /api/client-chat/messages
 * Sends a message in the client's ongoing conversation, grounded in their emails.
 */
router.post(
  '/messages',
  chatLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { message } = SendMessageSchema.parse(req.body);

    await audit('CLIENT_CHAT_QUERY', req, {
      userEmail: req.userEmail,
      details: { queryLength: message.length },
    });

    const result = await sendMessageInConversation(req.userId as string, message);

    await audit('CLIENT_CHAT_RESPONSE', req, {
      userEmail: req.userEmail,
      details: { responseLength: result.response.length },
    });

    res.json(result);
  }),
);

export default router;
