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
        (SELECT type FROM messages WHERE chat_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_message_type,
        (SELECT created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message_at,
        (SELECT sender_id FROM messages WHERE chat_id = c.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) as last_sender_id,
        (SELECT COUNT(*) FROM messages WHERE chat_id = c.id AND sender_id != $1 AND deleted_at IS NULL AND created_at >
          COALESCE((SELECT last_read_at FROM chat_members WHERE chat_id = c.id AND user_id = $1), '1970-01-01')) as unread_count,
        cm.is_muted,
        CASE WHEN c.type = 'direct' THEN
          (SELECT u.display_name FROM users u
           JOIN chat_members cm2 ON cm2.user_id = u.id
           WHERE cm2.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE c.name END as display_name,
        CASE WHEN c.type = 'direct' THEN
          (SELECT u.avatar_url FROM users u
           JOIN chat_members cm2 ON cm2.user_id = u.id
           WHERE cm2.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE c.avatar_url END as display_avatar,
        CASE WHEN c.type = 'direct' THEN
          (SELECT u.is_online FROM users u
           JOIN chat_members cm2 ON cm2.user_id = u.id
           WHERE cm2.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE false END as partner_online,
        CASE WHEN c.type = 'direct' THEN
          (SELECT u.last_seen_at FROM users u
           JOIN chat_members cm2 ON cm2.user_id = u.id
           WHERE cm2.chat_id = c.id AND u.id != $1 LIMIT 1)
        ELSE null END as partner_last_seen
       FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $1
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
    const { name, memberIds, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Название обязательно' });

    const chatResult = await query(
      `INSERT INTO chats (type, name, description, created_by) VALUES ('group', $1, $2, $3) RETURNING id`,
      [name, description || null, req.userId]
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

    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    let sql = `
      SELECT m.*,
        u.username, u.display_name, u.avatar_url,
        r.content as reply_content,
        r.type as reply_type,
        r.media_url as reply_media_url,
        ru.display_name as reply_sender,
        (SELECT json_agg(json_build_object('emoji', mr.emoji, 'count', mr.cnt, 'mine',
          EXISTS(SELECT 1 FROM message_reactions WHERE message_id = m.id AND user_id = $2 AND emoji = mr.emoji)))
         FROM (SELECT emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id = m.id GROUP BY emoji) mr
        ) as reactions,
        (SELECT COUNT(*) FROM message_reads WHERE message_id = m.id AND user_id != $2) as read_count
      FROM messages m
      JOIN users u ON u.id = m.sender_id
      LEFT JOIN messages r ON r.id = m.reply_to
      LEFT JOIN users ru ON ru.id = r.sender_id
      WHERE m.chat_id = $1 AND m.deleted_at IS NULL
    `;
    const params: any[] = [chatId, req.userId];

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

// Отправить сообщение (REST fallback)
router.post('/:chatId/messages', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { content, replyTo, type, mediaUrl, mediaMime, mediaSize, mediaDuration } = req.body;

    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    const result = await query(
      `INSERT INTO messages (chat_id, sender_id, content, reply_to, type, media_url, media_mime, media_size, media_duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [chatId, req.userId, content, replyTo || null,
       type || 'text', mediaUrl || null, mediaMime || null, mediaSize || null, mediaDuration || null]
    );

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отправки сообщения' });
  }
});

// Реакция на сообщение
router.post('/:chatId/messages/:messageId/react', async (req: AuthRequest, res: Response) => {
  try {
    const { messageId } = req.params;
    const { emoji } = req.body;
    if (!emoji) return res.status(400).json({ error: 'emoji обязателен' });

    // Toggle: если уже стоит — убираем
    const existing = await query(
      'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
      [messageId, req.userId, emoji]
    );

    if (existing.rows.length > 0) {
      await query('DELETE FROM message_reactions WHERE id = $1', [existing.rows[0].id]);
      res.json({ added: false, emoji });
    } else {
      await query(
        'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
        [messageId, req.userId, emoji]
      );
      res.json({ added: true, emoji });
    }
  } catch (err) {
    res.status(500).json({ error: 'Ошибка реакции' });
  }
});

// Закрепить сообщение
router.post('/:chatId/messages/:messageId/pin', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId, messageId } = req.params;
    // Проверяем что admin/owner
    const role = await query(
      'SELECT role FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (role.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    await query('UPDATE messages SET is_pinned = true WHERE id = $1 AND chat_id = $2', [messageId, chatId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка закрепления' });
  }
});

// Получить закреплённые сообщения
router.get('/:chatId/pinned', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    const result = await query(
      `SELECT m.*, u.display_name, u.username FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = $1 AND m.is_pinned = true AND m.deleted_at IS NULL
       ORDER BY m.created_at DESC`,
      [chatId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Участники группы
router.get('/:chatId/members', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    const result = await query(
      `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_online, u.last_seen_at, cm.role
       FROM chat_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.chat_id = $1
       ORDER BY cm.role DESC, u.display_name`,
      [chatId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка' });
  }
});

// Найти пользователя по username (legacy endpoint)
router.get('/users/search', async (req: AuthRequest, res: Response) => {
  try {
    const { q } = req.query;
    if (!q || String(q).length < 2) return res.json([]);

    const result = await query(
      `SELECT id, username, display_name, avatar_url, is_online, last_seen_at FROM users
       WHERE (username ILIKE $1 OR display_name ILIKE $1) AND id != $2 LIMIT 10`,
      [`%${q}%`, req.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Ошибка поиска' });
  }
});

export default router;
