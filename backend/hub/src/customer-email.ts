import nodemailer from 'nodemailer';
import type { CustomerMail } from './customer-accounts.js';

/** SMTP credentials are operator configuration, never sent to browsers or ESP32 devices. */
export function customerSmtp(url: string | undefined, from: string | undefined): CustomerMail | undefined {
  if (!url && !from) return undefined;
  if (!url || !from) throw new Error('Configure both CUSTOMER_SMTP_URL and CUSTOMER_SMTP_FROM.');
  const transport = nodemailer.createTransport({ url, pool: true, maxConnections: 2, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 }, { disableFileAccess: true, disableUrlAccess: true });
  return {
    async send(message) { await transport.sendMail({ ...message, from }); },
    close() { transport.close(); },
  };
}
