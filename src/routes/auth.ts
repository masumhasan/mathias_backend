import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { User } from '../models/User';
import {
  registerUser,
  resendOtp,
  verifyOtp,
  loginUser,
  getUserById,
  updateProfile,
  changePassword,
  requestPasswordReset,
  resetPassword,
} from '../services/authService';
import { audit } from '../services/auditService';
import { asyncHandler, createError } from '../middleware/errorHandler';
import { requireAuth } from '../middleware/requireAuth';
import { authLimiter, otpLimiter } from '../middleware/rateLimiter';

const router = Router();

const RegisterSchema = z.object({
  email: z.string().email('Invalid email address').max(254).toLowerCase().trim(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().min(1).max(100).trim(),
  phone: z.string().max(30).trim().optional().or(z.literal('')),
  country: z.string().max(100).trim().optional().or(z.literal('')),
  role: z.enum(['user', 'client']).optional().default('user'),
});

// Dev-only convenience: the OTP is normally only delivered by email. Exposing
// it in the API response (non-production only) lets us register/verify
// without a working mail setup while testing the client-chat portal.
const isDev = process.env.NODE_ENV !== 'production';

const VerifyOtpSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  otp: z.string().length(6),
});

const ResendOtpSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

const LoginSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  password: z.string().min(1),
});

const UpdateProfileSchema = z.object({
  firstName: z.string().min(1).max(100).trim().optional(),
  lastName: z.string().min(1).max(100).trim().optional(),
  phone: z.string().max(30).trim().optional().or(z.literal('')),
  country: z.string().max(100).trim().optional().or(z.literal('')),
  city: z.string().max(100).trim().optional().or(z.literal('')),
  bio: z.string().max(1000).trim().optional().or(z.literal('')),
});

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

const ForgotPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
});

const ResetPasswordSchema = z.object({
  email: z.string().email().toLowerCase().trim(),
  otp: z.string().length(6),
  newPassword: z.string().min(8, 'Password must be at least 8 characters').max(72),
});

/**
 * POST /api/auth/register
 * Creates an unverified account and emails a 6-digit OTP for verification.
 */
router.post(
  '/register',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const input = RegisterSchema.parse(req.body);
    const { email, otp } = await registerUser({
      ...input,
      phone: input.phone || undefined,
      country: input.country || undefined,
    });

    await audit('SESSION_CREATED', req, { userEmail: email, details: { stage: 'register' } });

    res.status(201).json({
      email,
      message: 'Verification code sent to your email.',
      ...(isDev ? { otp } : {}),
    });
  }),
);

/**
 * POST /api/auth/verify-otp
 * Confirms the OTP, marks the account verified, and returns a session token.
 */
router.post(
  '/verify-otp',
  otpLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, otp } = VerifyOtpSchema.parse(req.body);
    const result = await verifyOtp(email, otp);

    res.json(result);
  }),
);

/**
 * POST /api/auth/resend-otp
 */
router.post(
  '/resend-otp',
  otpLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = ResendOtpSchema.parse(req.body);
    const { otp } = await resendOtp(email);

    res.json({ message: 'Verification code resent.', ...(isDev ? { otp } : {}) });
  }),
);

/**
 * POST /api/auth/login
 */
router.post(
  '/login',
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = LoginSchema.parse(req.body);
    const result = await loginUser(email, password);

    res.json(result);
  }),
);

/**
 * GET /api/auth/me
 * Validates the bearer token and returns the current user.
 */
router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await getUserById(req.userId as string);
    if (!user) throw createError('User not found.', 404);

    res.json({ user });
  }),
);

/**
 * PATCH /api/auth/me
 * Updates the current user's profile fields.
 */
router.patch(
  '/me',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const input = UpdateProfileSchema.parse(req.body);
    const user = await updateProfile(req.userId as string, input);

    await audit('PROFILE_UPDATED', req, { userEmail: req.userEmail });

    res.json({ user });
  }),
);

/**
 * POST /api/auth/change-password
 * Updates the current user's password (requires current password).
 */
router.post(
  '/change-password',
  requireAuth,
  authLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    await changePassword(req.userId as string, currentPassword, newPassword);

    await audit('PASSWORD_CHANGED', req, { userEmail: req.userEmail });

    res.json({ message: 'Password updated successfully.' });
  }),
);

/**
 * POST /api/auth/forgot-password
 * Emails a 6-digit OTP that can be used to set a new password.
 */
router.post(
  '/forgot-password',
  otpLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email } = ForgotPasswordSchema.parse(req.body);
    await requestPasswordReset(email);

    await audit('PASSWORD_RESET_REQUESTED', req, { userEmail: email });

    res.json({ message: 'A password reset code has been sent to your email.' });
  }),
);

/**
 * POST /api/auth/reset-password
 * Verifies the OTP from /forgot-password and sets a new password.
 */
router.post(
  '/reset-password',
  otpLimiter,
  asyncHandler(async (req: Request, res: Response) => {
    const { email, otp, newPassword } = ResetPasswordSchema.parse(req.body);
    const result = await resetPassword(email, otp, newPassword);

    await audit('PASSWORD_RESET_COMPLETED', req, { userEmail: email });

    res.json(result);
  }),
);

/**
 * POST /api/auth/subscribe
 * Sets the authenticated user's subscription plan (no payment required yet).
 */
router.post(
  '/subscribe',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const { tier } = z.object({ tier: z.enum(['silver', 'gold', 'platinum']) }).parse(req.body);
    const user = await User.findByIdAndUpdate(
      req.userId,
      { subscriptionPlan: tier, subscribedAt: new Date() },
      { new: true },
    ).select('email firstName lastName subscriptionPlan subscribedAt');
    if (!user) throw createError('User not found.', 404);

    await audit('SUBSCRIPTION_ACTIVATED', req, { userEmail: req.userEmail, details: { tier } });

    res.json({ message: `${tier} subscription activated.`, subscriptionPlan: user.subscriptionPlan });
  }),
);

/**
 * POST /api/auth/logout
 * Stateless JWT — this just records the event for audit purposes.
 */
router.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    await audit('SESSION_ENDED', req, { userEmail: req.userEmail });
    res.json({ message: 'Logged out.' });
  }),
);

export default router;
