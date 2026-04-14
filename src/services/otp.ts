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

  // Временно логируем код в консоль
  console.log(`[OTP] ${email} → ${code}`);

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
