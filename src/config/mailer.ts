import nodemailer, { Transporter } from 'nodemailer';

let _transporter: Transporter | null = null;

export function getMailTransporter(): Transporter {
  if (!_transporter) {
    const user = process.env.EMAIL;
    const pass = process.env.APP_PASSWORD;
    if (!user || !pass) throw new Error('EMAIL and APP_PASSWORD must be defined in environment');

    _transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.mail.me.com',
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: false,
      requireTLS: true,
      auth: { user, pass },
    });
  }
  return _transporter;
}

export const MAIL_FROM = process.env.EMAIL || '';
