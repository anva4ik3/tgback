import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { query } from '../db';

interface AuthenticatedWS extends WebSocket {
  userId?: string;
  chatIds?: Set<string>;
}

const clients = new Map<string, Set<AuthenticatedWS>>();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: AuthenticatedWS, req) => {
    const token = new URL(req.url!, `http://localhost`).searchParams.get('token');

    if (!token) { ws.close(1008, 'Unauthorized'); return; }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      ws.userId = decoded.userId;
      ws.chatIds = new Set();

      if (!clients.has(ws.userId)) clients.set(ws.userId, new Set());
      clients.get(ws.userId)!.add(ws);

      // Ставим онлайн
      setOnlineStatus(ws.userId, true);

      ws.send(JSON.stringify({ type: 'connected', userId: ws.userId }));
    } catch {
      ws.close(1008, 'Invalid token');
      return;
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await handleMessage(ws, msg);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: 'Неверный формат' }));
      }
    });

    ws.on('close', () => {
      if (ws.userId) {
        clients.get(ws.userId)?.delete(ws);
        if (clients.get(ws.userId)?.size === 0) {
          clients.delete(ws.userId);
          setOnlineStatus(ws.userId, false);
        }
      }
    });
  });
}

async function setOnlineStatus(userId: string, online: boolean) {
  await query(
    `UPDATE users SET is_online = $1, last_seen_at = NOW() WHERE id = $2`,
    [online, userId]
  );
  // Уведомить контакты об изменении статуса
  const contacts = await query(
    `SELECT owner_id FROM contacts WHERE contact_id = $1
     UNION
     SELECT contact_id FROM contacts WHERE owner_id = $1`,
    [userId]
  );
  for (const row of contacts.rows) {
    const contactClients = clients.get(row.owner_id || row.contact_id);
    if (contactClients) {
      for (const c of contactClients) {
        if (c.readyState === WebSocket.OPEN) {
          c.send(JSON.stringify({ type: 'user_status', userId, online }));
        }
      }
    }
  }
}

async function handleMessage(ws: AuthenticatedWS, msg: any) {
  const { type, payload } = msg;

  switch (type) {
    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
      // Обновляем last_seen при пинге
      if (ws.userId) {
        await query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [ws.userId]);
      }
      break;
    }

    case 'join_chat': {
      const { chatId } = payload;
      const access = await query(
        'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [chatId, ws.userId]
      );
      if (access.rows.length > 0) {
        ws.chatIds!.add(chatId);
        ws.send(JSON.stringify({ type: 'joined_chat', chatId }));
      }
      break;
    }

    case 'send_message': {
      const { chatId, content, replyTo, type: msgType, mediaUrl, mediaMime, mediaSize, mediaDuration } = payload;
      if (!ws.chatIds?.has(chatId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Сначала войдите в чат' }));
        return;
      }

      const result = await query(
        `INSERT INTO messages (chat_id, sender_id, content, reply_to, type, media_url, media_mime, media_size, media_duration)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [chatId, ws.userId, content, replyTo || null,
         msgType || 'text', mediaUrl || null, mediaMime || null, mediaSize || null, mediaDuration || null]
      );

      const messageRow = result.rows[0];

      const userResult = await query(
        'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
        [ws.userId]
      );
      const user = userResult.rows[0];

      // Если есть reply, подгрузить
      let replyContent = null, replySender = null, replyMediaUrl = null;
      if (replyTo) {
        const replyResult = await query(
          `SELECT m.content, m.media_url, u.display_name FROM messages m
           JOIN users u ON u.id = m.sender_id WHERE m.id = $1`,
          [replyTo]
        );
        if (replyResult.rows.length > 0) {
          replyContent = replyResult.rows[0].content;
          replySender = replyResult.rows[0].display_name;
          replyMediaUrl = replyResult.rows[0].media_url;
        }
      }

      const outMessage = {
        type: 'new_message',
        message: {
          ...messageRow,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
          reply_content: replyContent,
          reply_sender: replySender,
          reply_media_url: replyMediaUrl,
          reactions: [],
          read_count: 0,
        },
      };

      await broadcastToChat(chatId, outMessage);
      break;
    }

    case 'typing': {
      const { chatId, isTyping } = payload;
      if (!ws.chatIds?.has(chatId)) return;

      await broadcastToChat(
        chatId,
        { type: 'typing', userId: ws.userId, isTyping },
        ws.userId
      );
      break;
    }

    case 'mark_read': {
      const { chatId, messageId } = payload;
      await query(
        `UPDATE chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND user_id = $2`,
        [chatId, ws.userId]
      );

      // Отметить конкретное сообщение как прочитанное
      if (messageId) {
        await query(
          `INSERT INTO message_reads (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [messageId, ws.userId]
        );
        await broadcastToChat(chatId, { type: 'message_read', messageId, userId: ws.userId }, ws.userId);
      }
      break;
    }

    case 'delete_message': {
      const { messageId, chatId } = payload;
      await query(
        `UPDATE messages SET deleted_at = NOW() WHERE id = $1 AND sender_id = $2`,
        [messageId, ws.userId]
      );
      await broadcastToChat(chatId, { type: 'message_deleted', messageId });
      break;
    }

    case 'edit_message': {
      const { messageId, chatId, content } = payload;
      const result = await query(
        `UPDATE messages SET content = $1, edited_at = NOW()
         WHERE id = $2 AND sender_id = $3 RETURNING *`,
        [content, messageId, ws.userId]
      );
      if (result.rows.length > 0) {
        await broadcastToChat(chatId, { type: 'message_edited', message: result.rows[0] });
      }
      break;
    }

    case 'react': {
      const { chatId, messageId, emoji } = payload;

      const existing = await query(
        'SELECT id FROM message_reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
        [messageId, ws.userId, emoji]
      );

      let added: boolean;
      if (existing.rows.length > 0) {
        await query('DELETE FROM message_reactions WHERE id = $1', [existing.rows[0].id]);
        added = false;
      } else {
        await query(
          'INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)',
          [messageId, ws.userId, emoji]
        );
        added = true;
      }

      // Получаем актуальные реакции
      const reactions = await query(
        `SELECT emoji, COUNT(*) as count FROM message_reactions WHERE message_id = $1 GROUP BY emoji`,
        [messageId]
      );

      await broadcastToChat(chatId, {
        type: 'reaction_update',
        messageId,
        reactions: reactions.rows,
        userId: ws.userId,
        emoji,
        added,
      });
      break;
    }

    case 'forward_message': {
      const { fromChatId, messagId, toChatId } = payload;

      const access = await query(
        'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
        [toChatId, ws.userId]
      );
      if (access.rows.length === 0) return;

      const orig = await query('SELECT * FROM messages WHERE id = $1', [messagId]);
      if (orig.rows.length === 0) return;

      const fwd = orig.rows[0];
      const result = await query(
        `INSERT INTO messages (chat_id, sender_id, content, type, media_url, media_mime, forwarded_from)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [toChatId, ws.userId, fwd.content, fwd.type, fwd.media_url, fwd.media_mime, fwd.id]
      );

      const userResult = await query(
        'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
        [ws.userId]
      );

      await broadcastToChat(toChatId, {
        type: 'new_message',
        message: { ...result.rows[0], ...userResult.rows[0], reactions: [] },
      });
      break;
    }
  }
}

async function broadcastToChat(chatId: string, data: any, excludeUserId?: string) {
  const members = await query(
    'SELECT user_id FROM chat_members WHERE chat_id = $1',
    [chatId]
  );

  for (const member of members.rows) {
    if (member.user_id === excludeUserId) continue;
    const userClients = clients.get(member.user_id);
    if (userClients) {
      for (const client of userClients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      }
    }
  }
}

export { clients };
