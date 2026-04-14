import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Получить список контактов
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.bio,
        u.is_online, u.last_seen_at, c.nickname, c.added_at
       FROM contacts c
       JOIN users u ON u.id = c.contact_id
       WHERE c.owner_id = $1
       ORDER BY COALESCE(c.nickname, u.display_name) ASC`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки контактов' });
  }
});

// Добавить контакт по username
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { username, nickname } = req.body;
    if (!username) return res.status(400).json({ error: 'username обязателен' });

    const userResult = await query(
      'SELECT id, username, display_name, avatar_url FROM users WHERE username = $1',
      [username.toLowerCase()]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }

    const contact = userResult.rows[0];
    if (contact.id === req.userId) {
      return res.status(400).json({ error: 'Нельзя добавить себя' });
    }

    await query(
      `INSERT INTO contacts (owner_id, contact_id, nickname)
       VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, contact_id) DO UPDATE SET nickname = EXCLUDED.nickname`,
      [req.userId, contact.id, nickname || null]
    );

    res.json({ success: true, contact });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления контакта' });
  }
});

// Удалить контакт
router.delete('/:contactId', async (req: AuthRequest, res: Response) => {
  try {
    await query(
      'DELETE FROM contacts WHERE owner_id = $1 AND contact_id = $2',
      [req.userId, req.params.contactId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления контакта' });
  }
});

// Поиск пользователей глобально
router.get('/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || String(q).length < 2) return res.json([]);

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen_at,
        EXISTS(SELECT 1 FROM contacts WHERE owner_id = $2 AND contact_id = u.id) as is_contact
       FROM users u
       WHERE (u.username ILIKE $1 OR u.display_name ILIKE $1) AND u.id != $2
       LIMIT 20`,
      [`%${q}%`, req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

// Сохранить push-токен
router.post('/push-token', async (req: AuthRequest, res: Response) => {
  try {
    const { token, platform } = req.body;
    if (!token) return res.status(400).json({ error: 'token обязателен' });

    await query(
      `INSERT INTO push_tokens (user_id, token, platform, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, token) DO UPDATE SET updated_at = NOW()`,
      [req.userId, token, platform || 'android']
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сохранения токена' });
  }
});

export default router;
