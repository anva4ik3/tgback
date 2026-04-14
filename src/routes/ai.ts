import { Router, Response } from 'express';
import { query } from '../db';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { getAIResponse, summarizeChat } from '../services/groq';

const router = Router();
router.use(authMiddleware);

// AI-ответ в контексте чата
router.post('/chat/:chatId', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;
    const { message, includeHistory } = req.body;

    if (!message) return res.status(400).json({ error: 'message обязателен' });

    // Проверяем доступ
    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    let chatHistory: { role: 'user' | 'assistant'; content: string }[] = [];

    if (includeHistory) {
      // Берём последние AI-сообщения для контекста
      const history = await query(
        `SELECT content, type FROM messages 
         WHERE chat_id = $1 AND deleted_at IS NULL AND type IN ('text', 'ai')
         ORDER BY created_at DESC LIMIT 20`,
        [chatId]
      );
      chatHistory = history.rows.reverse().map((m: any) => ({
        role: m.type === 'ai' ? 'assistant' : 'user',
        content: m.content,
      }));
    }

    const aiResponse = await getAIResponse(message, chatHistory);

    // Сохраняем AI-сообщение в чат
    await query(
      `INSERT INTO messages (chat_id, sender_id, content, type) VALUES ($1, $2, $3, 'ai')`,
      [chatId, req.userId, aiResponse]
    );

    res.json({ response: aiResponse });
  } catch (err) {
    console.error('ai chat error:', err);
    res.status(500).json({ error: 'Ошибка AI' });
  }
});

// Суммаризация чата
router.get('/summarize/:chatId', async (req: AuthRequest, res: Response) => {
  try {
    const { chatId } = req.params;

    const access = await query(
      'SELECT 1 FROM chat_members WHERE chat_id = $1 AND user_id = $2',
      [chatId, req.userId]
    );
    if (access.rows.length === 0) return res.status(403).json({ error: 'Нет доступа' });

    const messages = await query(
      `SELECT u.display_name as sender, m.content FROM messages m
       JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = $1 AND m.deleted_at IS NULL AND m.type != 'ai'
       ORDER BY m.created_at DESC LIMIT 50`,
      [chatId]
    );

    if (messages.rows.length === 0) {
      return res.json({ summary: 'Чат пуст.' });
    }

    const summary = await summarizeChat(messages.rows.reverse());
    res.json({ summary });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка суммаризации' });
  }
});

// Свободный вопрос (без чата)
router.post('/ask', async (req: AuthRequest, res: Response) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message обязателен' });

    const response = await getAIResponse(message);
    res.json({ response });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка AI' });
  }
});

export default router;
