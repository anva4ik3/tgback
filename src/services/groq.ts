import Groq from 'groq-sdk';

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

export async function getAIResponse(
  userMessage: string,
  chatHistory: { role: 'user' | 'assistant'; content: string }[] = []
): Promise<string> {
  const messages = [
    {
      role: 'system' as const,
      content: `Ты AI-ассистент в мессенджере. Ты помогаешь пользователям с вопросами, переводишь текст, 
      суммаризируешь переписку, предлагаешь ответы. Отвечай кратко и по делу. 
      Текущая дата: ${new Date().toLocaleDateString('ru-RU')}.`,
    },
    ...chatHistory.slice(-10), // последние 10 сообщений для контекста
    { role: 'user' as const, content: userMessage },
  ];

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages,
    max_tokens: 1024,
    temperature: 0.7,
  });

  return completion.choices[0]?.message?.content || 'Не могу ответить на этот запрос.';
}

export async function summarizeChat(
  messages: { sender: string; content: string }[]
): Promise<string> {
  const chatText = messages
    .map((m) => `${m.sender}: ${m.content}`)
    .join('\n');

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'user',
        content: `Сделай краткое резюме этого чата (2-3 предложения):\n\n${chatText}`,
      },
    ],
    max_tokens: 256,
  });

  return completion.choices[0]?.message?.content || 'Не удалось создать резюме.';
}
