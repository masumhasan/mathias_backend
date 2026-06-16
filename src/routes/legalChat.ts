import { Router, Request, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import {
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  sendMessageInConversation,
} from '../services/legalConversationService';
import { audit } from '../services/auditService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { chatLimiter, sessionLimiter } from '../middleware/rateLimiter';

const router = Router();

const SendMessageSchema = z.object({
  message: z
    .string()
    .min(1, 'Message cannot be empty')
    .max(2000, 'Message too long (max 2000 characters)')
    .trim(),
});

function requireValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw createError('Conversation not found.', 404);
}

/**
 * GET /api/legal-chat/conversations
 * Lists the current user's conversation history for the sidebar.
 */
router.get(
  '/conversations',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const conversations = await listConversations(req.userId as string);
    res.json({ conversations });
  }),
);

/**
 * POST /api/legal-chat/conversations
 * Starts a new, empty conversation ("New Consultation").
 */
router.post(
  '/conversations',
  requireAuth,
  sessionLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const conversation = await createConversation(req.userId as string);
    res.status(201).json({ conversation });
  }),
);

/**
 * GET /api/legal-chat/conversations/:id
 * Returns the full message history for one conversation.
 */
router.get(
  '/conversations/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const conversation = await getConversation(req.userId as string, req.params.id);
    res.json({ conversation });
  }),
);

/**
 * DELETE /api/legal-chat/conversations/:id
 * Deletes one of the current user's conversations.
 */
router.delete(
  '/conversations/:id',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    await deleteConversation(req.userId as string, req.params.id);
    res.status(204).send();
  }),
);

/**
 * POST /api/legal-chat/conversations/:id/messages
 * Sends a message within a conversation, persists both sides to MongoDB.
 */
router.post(
  '/conversations/:id/messages',
  requireAuth,
  chatLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const { message } = SendMessageSchema.parse(req.body);

    await audit('LEGAL_CHAT_QUERY', req, {
      userEmail: req.userEmail,
      details: { conversationId: req.params.id, queryLength: message.length },
    });

    const result = await sendMessageInConversation(req.userId as string, req.params.id, message);

    await audit('LEGAL_CHAT_RESPONSE', req, {
      userEmail: req.userEmail,
      details: { conversationId: req.params.id, responseLength: result.response.length },
    });

    res.json(result);
  }),
);

export default router;
