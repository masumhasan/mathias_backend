import { Router, Request, Response } from 'express';
import { z } from 'zod';
import mongoose from 'mongoose';
import {
  listLegalAdviceClients,
  getLegalAdviceClient,
  updateLegalAdviceClient,
  setLegalAdviceClientBanned,
  deleteLegalAdviceClient,
  listClientChats,
  getClientChatDetail,
  listRecentActivity,
  listPackages,
  createPackage,
  updatePackage,
  deletePackage,
} from '../services/adminService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { requireAdmin } from '../middleware/requireAdmin';

const router = Router();

const PackageSchema = z.object({
  name: z.string().trim().min(1).max(100),
  price: z.number().min(0),
  description: z.string().trim().min(1).max(2000),
});

const UpdateClientSchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().optional(),
  country: z.string().trim().optional(),
  city: z.string().trim().optional(),
  bio: z.string().trim().max(1000).optional(),
});

const BanClientSchema = z.object({
  banned: z.boolean(),
});

function requireValidId(id: string): void {
  if (!mongoose.isValidObjectId(id)) throw createError('Client not found.', 404);
}

router.use(requireAuth, requireAdmin);

/**
 * GET /api/admin/legal-advice-clients
 * Lists every registered user and their /legalchat usage, for the admin dashboard.
 */
router.get(
  '/legal-advice-clients',
  asyncHandler(async (_req: Request, res: Response) => {
    const clients = await listLegalAdviceClients();
    res.json({ clients });
  }),
);

/**
 * GET /api/admin/legal-advice-clients/:id
 * Returns the full profile for one client (the "view account" detail page).
 */
router.get(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const client = await getLegalAdviceClient(req.params.id);
    res.json({ client });
  }),
);

/**
 * PATCH /api/admin/legal-advice-clients/:id
 * Edits a client's profile fields.
 */
router.patch(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const input = UpdateClientSchema.parse(req.body);
    const client = await updateLegalAdviceClient(req.params.id, input);
    res.json({ client });
  }),
);

/**
 * PATCH /api/admin/legal-advice-clients/:id/ban
 * Bans or unbans a client, instantly cutting off any already-issued session.
 */
router.patch(
  '/legal-advice-clients/:id/ban',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const { banned } = BanClientSchema.parse(req.body);
    const client = await setLegalAdviceClientBanned(req.params.id, banned);
    res.json({ client });
  }),
);

/**
 * DELETE /api/admin/legal-advice-clients/:id
 * Deletes a client's account and all of their conversations.
 */
router.delete(
  '/legal-advice-clients/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    await deleteLegalAdviceClient(req.params.id);
    res.status(204).send();
  }),
);

/**
 * GET /api/admin/client-chats
 * Lists every /client-chat portal user and their last message, for the
 * "Client Chats" admin page (formerly "Inbox").
 */
router.get(
  '/client-chats',
  asyncHandler(async (_req: Request, res: Response) => {
    const clients = await listClientChats();
    res.json({ clients });
  }),
);

/**
 * GET /api/admin/client-chats/:id
 * Returns one client's full conversation transcript, for the eye-icon modal.
 */
router.get(
  '/client-chats/:id',
  asyncHandler(async (req: Request, res: Response) => {
    requireValidId(req.params.id);
    const client = await getClientChatDetail(req.params.id);
    res.json({ client });
  }),
);

/**
 * GET /api/admin/activity
 * Lists the most recent audit log entries across the app, for the Overview
 * page's "Recent Activity" feed.
 */
router.get(
  '/activity',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50);
    const activity = await listRecentActivity(limit);
    res.json({ activity });
  }),
);

/**
 * GET /api/admin/packages
 * Lists all service packages.
 */
router.get(
  '/packages',
  asyncHandler(async (_req: Request, res: Response) => {
    const packages = await listPackages();
    res.json({ packages });
  }),
);

/**
 * POST /api/admin/packages
 * Creates a new service package.
 */
router.post(
  '/packages',
  asyncHandler(async (req: Request, res: Response) => {
    const input = PackageSchema.parse(req.body);
    const pkg = await createPackage(input);
    res.status(201).json({ package: pkg });
  }),
);

/**
 * PATCH /api/admin/packages/:id
 * Updates an existing service package.
 */
router.patch(
  '/packages/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Package not found.', 404);
    const input = PackageSchema.parse(req.body);
    const pkg = await updatePackage(req.params.id, input);
    res.json({ package: pkg });
  }),
);

/**
 * DELETE /api/admin/packages/:id
 * Deletes a service package.
 */
router.delete(
  '/packages/:id',
  asyncHandler(async (req: Request, res: Response) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw createError('Package not found.', 404);
    await deletePackage(req.params.id);
    res.status(204).send();
  }),
);

export default router;
