export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
  tls: { rejectUnauthorized: boolean };
}

export function getImapConfig(): ImapConfig {
  const user = process.env.EMAIL;
  const pass = process.env.APP_PASSWORD;

  if (!user || !pass) {
    throw new Error('EMAIL and APP_PASSWORD must be defined in environment');
  }

  return {
    host: process.env.IMAP_HOST || 'imap.mail.me.com',
    port: parseInt(process.env.IMAP_PORT || '993', 10),
    secure: true,
    auth: { user, pass },
    logger: false,
    tls: { rejectUnauthorized: true },
  };
}
