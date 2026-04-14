import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { query } from '../db';
import { sendOTP, verifyOTP } from '../services/otp';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

router.post('/send-otp', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    await sendOTP(email);
    res.json({ success: true, message: 'Код отправлен' });
  } catch (err) {
    console.error('send-otp error:', err);
    res.status(500).json({ error: 'Ошибка отправки кода' });
  }
});

router.post('/verify-otp', async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email и код обязательны' });
    }
    const valid = await verifyOTP(email, code);
    if (!valid) {
      return res.status(400).json({ error: 'Неверный или истёкший код' });
    }
    const userResult = await query('SELECT * FROM users WHERE email = $1', [email]);
    const isNewUser = userResult.rows.length === 0;
    res.json({ success: true, isNewUser, email });
  } catch (err) {
    console.error('verify-otp error:', err);
    res.status(500).json({ error: 'Ошибка проверки кода' });
  }
});

router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, username, displayName } = req.body;
    if (!email || !username) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }

    const otpCheck = await query(
      `SELECT id FROM otp_codes WHERE email = $1 AND used = true ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (otpCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Требуется повторная верификация' });
    }

    const usernameCheck = await query('SELECT id FROM users WHERE username = $1', [username]);
    if (usernameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Имя пользователя уже занято' });
    }

    const result = await query(
      `INSERT INTO users (email, username, display_name, is_verified) 
       VALUES ($1, $2, $3, true) RETURNING *`,
      [email, username.toLowerCase(), displayName || username]
    );

    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );

    res.json({ success: true, token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Ошибка регистрации' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email и код обязательны' });
    }
    const valid = await verifyOTP(email, code);
    if (!valid) {
      return res.status(400).json({ error: 'Неверный или истёкший код' });
    }
    const result = await query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    const user = result.rows[0];
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET!,
      { expiresIn: '30d' }
    );
    res.json({ success: true, token, user: sanitizeUser(user) });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Ошибка входа' });
  }
});

router.get('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const result = await query('SELECT * FROM users WHERE id = $1', [req.userId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json(sanitizeUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

router.patch('/me', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { displayName, bio, avatarUrl } = req.body;
    const result = await query(
      `UPDATE users SET 
        display_name = COALESCE($1, display_name),
        bio = COALESCE($2, bio),
        avatar_url = COALESCE($3, avatar_url)
       WHERE id = $4 RETURNING *`,
      [displayName, bio, avatarUrl, req.userId]
    );
    res.json(sanitizeUser(result.rows[0]));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления профиля' });
  }
});

function sanitizeUser(user: any) {
  const { ...safe } = user;
  return safe;
}

export default router;
