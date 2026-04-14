import { query } from '../db';

export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export async function sendOTP(email: string): Promise<string> {
  const code = generateOTP();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await query('DELETE FROM otp_codes WHERE email = $1', [email]);
  await query(
    'INSERT INTO otp_codes (email, code, expires_at) VALUES ($1, $2, $3)',
    [email, code, expiresAt]
  );

  // Resend HTTP API вместо SMTP
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SMTP_PASS}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: email,
      subject: 'Код подтверждения',
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto;">
          <h2>Ваш код подтверждения</h2>
          <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #6366f1; padding: 20px 0;">
            ${code}
          </div>
          <p>Код действует 10 минут.</p>
        </div>
      `,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend error: ${JSON.stringify(err)}`);
  }

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

  await query('UPDATE otp_codes SET used = true WHERE id = $1', [result.rows[0].id]);
  return true;
}
