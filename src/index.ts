import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config();

import { pool } from './db';
import { setupWebSocket } from './ws/handler';
import authRoutes from './routes/auth';
import chatsRoutes from './routes/chats';
import channelsRoutes from './routes/channels';
import aiRoutes from './routes/ai';
import contactsRoutes from './routes/contacts';
import mediaRoutes from './routes/media';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true,
}));
app.use(express.json({ limit: '15mb' }));

// Health check
app.get('/health', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/channels', channelsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/contacts', contactsRoutes);
app.use('/api/media', mediaRoutes);

// WebSocket
setupWebSocket(wss);

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  try {
    await pool.query('SELECT 1');
    console.log(`✅ DB connected`);

    const sqlPath = path.join(__dirname, '..', 'migrations', 'init.sql');
    const sql = fs.readFileSync(sqlPath, 'utf-8');
    await pool.query(sql);
    console.log(`✅ Migrations applied`);
  } catch (err) {
    console.error('❌ Startup error:', err);
  }
  console.log(`🚀 Server running on port ${PORT}`);
});
