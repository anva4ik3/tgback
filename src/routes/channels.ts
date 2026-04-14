import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Создать канал
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { username, name, description, isPublic, monthlyPrice } = req.body;
    if (!username || !name) return res.status(400).json({ error: 'username и name обязательны' });

    const check = await query('SELECT id FROM channels WHERE username = $1', [username]);
    if (check.rows.length > 0) return res.status(400).json({ error: 'Username уже занят' });

    const result = await query(
      `INSERT INTO channels (owner_id, username, name, description, is_public, monthly_price)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.userId, username.toLowerCase(), name, description, isPublic ?? true, monthlyPrice ?? 0]
    );

    // Автоматически подписываем создателя
    await query(
      'INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2)',
      [result.rows[0].id, req.userId]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания канала' });
  }
});

// Получить список каналов (публичные)
router.get('/explore', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;
    let sql = `SELECT c.*, u.display_name as owner_name, u.avatar_url as owner_avatar,
      EXISTS(SELECT 1 FROM channel_subscribers WHERE channel_id = c.id AND user_id = $1) as is_subscribed
      FROM channels c JOIN users u ON u.id = c.owner_id
      WHERE c.is_public = true`;
    const params: any[] = [req.userId];

    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (c.name ILIKE $${params.length} OR c.username ILIKE $${params.length})`;
    }

    sql += ' ORDER BY c.subscriber_count DESC LIMIT 30';
    const result = await query(sql, params);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки каналов' });
  }
});

// Мои каналы (где я подписан)
router.get('/my', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.* FROM channels c
       JOIN channel_subscribers cs ON cs.channel_id = c.id
       WHERE cs.user_id = $1
       ORDER BY c.name`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Получить канал по username
router.get('/:username', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.*, u.display_name as owner_name, u.avatar_url as owner_avatar,
        EXISTS(SELECT 1 FROM channel_subscribers WHERE channel_id = c.id AND user_id = $2) as is_subscribed,
        c.owner_id = $2 as is_owner
       FROM channels c JOIN users u ON u.id = c.owner_id
       WHERE c.username = $1`,
      [req.params.username, req.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Канал не найден' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Подписаться / отписаться
router.post('/:channelId/subscribe', async (req: AuthRequest, res: Response) => {
  try {
    const { channelId } = req.params;

    const existing = await query(
      'SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2',
      [channelId, req.userId]
    );

    if (existing.rows.length > 0) {
      // Отписываемся
      await query('DELETE FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2', [channelId, req.userId]);
      await query('UPDATE channels SET subscriber_count = subscriber_count - 1 WHERE id = $1', [channelId]);
      res.json({ subscribed: false });
    } else {
      // Подписываемся
      await query('INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2)', [channelId, req.userId]);
      await query('UPDATE channels SET subscriber_count = subscriber_count + 1 WHERE id = $1', [channelId]);
      res.json({ subscribed: true });
    }
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Посты канала
router.get('/:channelId/posts', async (req: AuthRequest, res: Response) => {
  try {
    const { channelId } = req.params;
    const channel = await query('SELECT * FROM channels WHERE id = $1', [channelId]);
    if (channel.rows.length === 0) return res.status(404).json({ error: 'Не найдено' });

    const isSubscriber = await query(
      'SELECT 1 FROM channel_subscribers WHERE channel_id = $1 AND user_id = $2',
      [channelId, req.userId]
    );

    const isOwner = channel.rows[0].owner_id === req.userId;
    const hasAccess = isOwner || isSubscriber.rows.length > 0;

    const result = await query(
      `SELECT * FROM channel_posts WHERE channel_id = $1 
       ${!hasAccess ? 'AND is_paid = false' : ''}
       ORDER BY created_at DESC LIMIT 20`,
      [channelId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки постов' });
  }
});

// Создать пост (только владелец)
router.post('/:channelId/posts', async (req: AuthRequest, res: Response) => {
  try {
    const { channelId } = req.params;
    const { content, mediaUrls, isPaid } = req.body;

    const channel = await query('SELECT * FROM channels WHERE id = $1 AND owner_id = $2', [channelId, req.userId]);
    if (channel.rows.length === 0) return res.status(403).json({ error: 'Нет прав' });

    const result = await query(
      `INSERT INTO channel_posts (channel_id, content, media_urls, is_paid) VALUES ($1, $2, $3, $4) RETURNING *`,
      [channelId, content, mediaUrls || [], isPaid ?? false]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания поста' });
  }
});

// Отправить донат
router.post('/:channelId/donate', async (req: AuthRequest, res: Response) => {
  try {
    const { channelId } = req.params;
    const { amount, message } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Некорректная сумма' });

    await query(
      'INSERT INTO donations (from_user_id, to_channel_id, amount, message) VALUES ($1, $2, $3, $4)',
      [req.userId, channelId, amount, message]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка доната' });
  }
});

export default router;
