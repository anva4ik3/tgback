import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
router.use(authMiddleware);

// Получить все чаты пользователя
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await query(
      `SELECT c.*, 
        (SELECT content FROM messages WHERE chat_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_message,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND sender_id != $1 AND created_at > 
          COALESCE((SELECT last_read_at FROM chat_members WHERE chat_id = c.id AND user_id = $1), '1970-01-01')) as unread_count,
        CASE WHEN c.type = 'direct' THEN 
          (SELECT u.display_name FROM users u 
           JOIN chat_members cm ON cm.user_id = u.id 
           WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE c.name END as display_name,
        CASE WHEN c.type = 'direct' THEN 
          (SELECT u.avatar_url FROM users u 
           JOIN chat_members cm ON cm.user_id = u.id 
           WHERE cm.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE c.avatar_url END as display_avatar
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = $1
       ORDER BY last_message_at DESC NULLS LAST`,
      [req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки чатов' });
  }
});

// Создать или открыть личный чат
router.post('/direct', async (req: AuthRequest, res: Response) => {
  try {
    const { targetUserId } = req.body;
    if (!targetUserId) return res.status(400).json({ error: 'targetUserId обязателен' });
    if (targetUserId === req.userId) return res.status(400).json({ error: 'Нельзя создать чат с собой' });

    // Проверяем — есть ли уже личный чат между этими двумя
    const existing = await query(
      `SELECT c.id FROM chats c
       JOIN chat_members cm1 ON cm1.chat_id = c.id AND cm1.user_id = $1
       JOIN chat_members cm2 ON cm2.chat_id = c.id AND cm2.user_id = $2
       WHERE c.type = 'direct' LIMIT 1`,
      [req.userId, targetUserId]
    );

    if (existing.rows.length > 0) {
      return res.json({ chatId: existing.rows[0].id, existed: true });
    }

    // Создаём новый
    const chatResult = await query(
      `INSERT INTO chats (type, created_by) VALUES ('direct', $1) RETURNING id`,
      [req.userId]
    );
    const chatId = chatResult.rows[0].id;

    await query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`,
      [chatId, req.userId, targetUserId]
    );

    res.json({ chatId, existed: false });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания чата' });
  }
});

// Создать группу
router.post('/group', async (req: AuthRequest, res: Response) => {
  try {
    const { name, memberIds } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const chatResult = await query(
      `INSERT INTO chats (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
      [name, req.userId]
    );
    const chatId = chatResult.rows[0].id;

    const members = [req.userId, ...(memberIds || [])].filter(
      (v: string, i: number, a: string[]) => a.indexOf(v) === i
    );

    for (const memberId of members) {
      const role = memberId === req.userId ? 'owner' : 'member';
      await query(
        `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, $3)`,
        [chatId, memberId, role]
      );
    }

    res.json({ chatId });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

// Получить сообщения чата
router.get('/:chatId/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { before, limit = 50 } = req.query;

    // Проверяем доступ
    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    let sql = `
      SELECT m.*, u.username, u.display_name, u.avatar_url,
        r.content as reply_content,
        ru.display_name as reply_sender
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN messages r ON r.id = m.reply_to
      LEFT JOIN users ru ON ru.id = r.sender_id
      WHERE m.chat_id = $1 AND m.deleted_at IS NULL
    `;
    const params: any[] = [chatId];

    if (before) {
      params.push(before);
      sql += ` AND m.created_at < $${params.length}`;
    }

    sql += ` ORDER BY m.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(sql, params);
    res.json(result.rows.reverse());
  } catch (err) {
    res.status(500).json({ error: 'Ошибка загрузки сообщений' });
  }
});

// Отправить сообщение (REST fallback, основное через WS)
router.post('/:chatId/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { content, replyTo } = req.body;

    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    const result = await query(
      `INSERT INTO messages (chat_id, sender_id, content, reply_to) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [chatId, req.userId, content, replyTo || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отправки сообщения' });
  }
});

// Найти пользователя по username
router.get('/users/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || String(q).length < 2) return res.json([]);

    const result = await query(
      `SELECT id, username, display_name, avatar_url FROM users 
       WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2 LIMIT 10`,
      [`%${q}%`, req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

export default router;
