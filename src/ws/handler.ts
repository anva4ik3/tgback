import { WebSocket, WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { query } from '../db';

interface AuthenticatedWS extends WebSocket {
  userId?: string;
  chatIds?: Set<string>;
}

// userId -> Set of WebSocket connections
const clients = new Map<string, Set<AuthenticatedWS>>();

export function setupWebSocket(wss: WebSocketServer) {
  wss.on('connection', (ws: AuthenticatedWS, req) => {
    const token = new URL(req.url!, `http://localhost`).searchParams.get('token');

    if (!token) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as { userId: string };
      ws.userId = decoded.userId;
      ws.chatIds = new Set();

      if (!clients.has(ws.userId)) clients.set(ws.userId, new Set());
      clients.get(ws.userId)!.add(ws);

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
        if (clients.get(ws.userId)?.size === 0) clients.delete(ws.userId);
      }
    });
  });
}

async function handleMessage(ws: AuthenticatedWS, msg: any) {
  const { type, payload } = msg;

  switch (type) {
    // Fix: handle ping — не крашим сервер
    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }));
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
      const { chatId, content, replyTo } = payload;
      if (!ws.chatIds?.has(chatId)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Сначала войдите в чат' }));
        return;
      }

      const result = await query(
        `INSERT INTO messages (chat_id, sender_id, content, reply_to) VALUES ($1, $2, $3, $4) RETURNING *`,
        [chatId, ws.userId, content, replyTo || null]
      );

      const messageRow = result.rows[0];

      const userResult = await query(
        'SELECT username, display_name, avatar_url FROM users WHERE id = $1',
        [ws.userId]
      );
      const user = userResult.rows[0];

      const outMessage = {
        type: 'new_message',
        message: {
          ...messageRow,
          username: user.username,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
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
      const { chatId } = payload;
      await query(
        `UPDATE chat_members SET last_read_at = NOW() WHERE chat_id = $1 AND user_id = $2`,
        [chatId, ws.userId]
      );
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
  }
}

// Fix: кешируем участников чата в памяти для broadcast
// вместо SQL-запроса на каждое сообщение используем clients map
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
