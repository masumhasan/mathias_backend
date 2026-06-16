import { Request } from 'express';
import { AuditLog, AuditEventType } from '../models/AuditLog';
import logger from '../utils/logger';

interface AuditContext {
  userEmail?: string;
  sessionId?: string;
  details?: Record<string, unknown>;
}

export async function audit(
  eventType: AuditEventType,
  req: Request,
  context: AuditContext = {},
): Promise<void> {
  try {
    await AuditLog.create({
      eventType,
      userEmail: context.userEmail,
      sessionId: context.sessionId,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: context.details || {},
      timestamp: new Date(),
    });
  } catch (err) {
    // Audit failures must not disrupt the main request flow
    logger.error('Failed to write audit log', { eventType, error: (err as Error).message });
  }
}

export async function auditSystem(
  eventType: AuditEventType,
  details: Record<string, unknown> = {},
): Promise<void> {
  try {
    await AuditLog.create({
      eventType,
      ipAddress: 'system',
      details,
      timestamp: new Date(),
    });
  } catch (err) {
    logger.error('Failed to write system audit log', { eventType, error: (err as Error).message });
  }
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
