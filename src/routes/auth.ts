router.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, code, username, displayName } = req.body;
    if (!email || !code || !username) {
      return res.status(400).json({ error: 'Все поля обязательны' });
    }

    // Просто проверяем что пользователь с таким email уже верифицирован
    // (не вызываем verifyOTP повторно — код уже использован на шаге 2)
    const otpCheck = await query(
      `SELECT id FROM otp_codes WHERE email = $1 AND used = true ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (otpCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Требуется повторная верификация' });
    }

    // Проверяем уникальность username
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
