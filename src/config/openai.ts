import OpenAI from 'openai';

let _client: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not defined in environment');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// legalchat needs stronger factual recall (addresses, general knowledge) than the
// email-grounded client-chat, so it gets its own, separately tunable model.
export const LEGAL_CHAT_MODEL = process.env.LEGAL_CHAT_MODEL || 'gpt-4o';
