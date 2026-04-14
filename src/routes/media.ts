import { Router, Response, Request } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { query } from '../db';
import crypto from 'crypto';

const router = Router();
router.use(authMiddleware);

// Upload base64 media (images, voice, files)
// В продакшне нужно заменить на S3/Cloudinary
router.post('/upload', async (req: AuthRequest, res: Response) => {
  try {
    const { data, mime, filename } = req.body;
    if (!data || !mime) return res.status(400).json({ error: 'data и mime обязательны' });

    // Валидация размера (max 10MB base64 ≈ 7.5MB файл)
    if (data.length > 14_000_000) {
      return res.status(413).json({ error: 'Файл слишком большой (макс 10MB)' });
    }

    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp',
                     'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/aac',
                     'application/pdf', 'video/mp4'];
    if (!allowed.includes(mime)) {
      return res.status(400).json({ error: 'Тип файла не поддерживается' });
    }

    // Генерируем уникальный ключ
    const key = crypto.randomUUID();
    const ext = mime.split('/')[1].replace('jpeg', 'jpg');
    const fileId = `${key}.${ext}`;

    // В реальном проекте: загружаем в S3/Cloudinary
    // Сейчас: возвращаем data URI для простоты
    const mediaUrl = `data:${mime};base64,${data}`;

    res.json({
      url: mediaUrl,
      fileId,
      mime,
      size: Math.round(data.length * 0.75),
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Ошибка загрузки' });
  }
});

export default router;
