import nodemailer from 'nodemailer';
import { query } from '../db';

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.resend.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: true,
  auth: {
    user: process.env.SMTP_USER || 'resend',
    pass: process.env.SMTP_PASS,
  },
});

export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendOTP(email: string): Promise<string> {
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 минут

  // Удаляем старые коды
  await query('DELETE FROM otp_codes WHERE email = $1', [email]);

  // Сохраняем новый
  await query(
    'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
    [email, code, expiresAt]
  );

  // Отправляем письмо
  await transporter.sendMail({
    from: process.env.FROM_EMAIL || 'noreply@yourmessenger.app',
    to: email,
    subject: 'Код подтверждения',
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
        <h2>Ваш код подтверждения</h2>
        <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #6366f1; padding: 20px 0;">
          ${code}
        </div>
        <p>Код действует 10 минут.</p>
        <p style="color: #999; font-size: 12px;">Если вы не запрашивали код, проигнорируйте это письмо.</p>
      </div>
    `,
  });

  return code;
}

export async function verifyOTP(email: string, code: string): Promise<boolean> {
  const result = await query(
    `SELECT id FROM otp_codes 
     WHERE email = $1 AND code = $2 AND expires_at > NOW() AND used = false
     LIMIT 1`,
    [email, code]
  );

  if (result.rows.length === 0) return false;

  // Помечаем как использованный
  await query('UPDATE otp_codes SET used = true WHERE id = $1', [result.rows[0].id]);
  return true;
}
