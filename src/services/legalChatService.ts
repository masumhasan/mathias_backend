import { getOpenAIClient, LEGAL_CHAT_MODEL } from '../config/openai';
import { LEGAL_CHAT_SYSTEM_PROMPT } from '../config/prompts/legalChatPrompt';
import logger from '../utils/logger';

const MAX_HISTORY_MESSAGES = 10;

export interface LegalChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export async function sendLegalChatMessage(
  message: string,
  history: LegalChatMessage[],
): Promise<string> {
  const openai = getOpenAIClient();

  const completion = await openai.chat.completions.create({
    model: LEGAL_CHAT_MODEL,
    temperature: 0.3,
    max_tokens: 1200,
    // Guards against degenerate repetition loops (e.g. the model padding out
    // an answer it's unsure of with a runaway list of numbers).
    frequency_penalty: 0.6,
    presence_penalty: 0.3,
    messages: [
      { role: 'system', content: LEGAL_CHAT_SYSTEM_PROMPT },
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: 'user', content: message },
    ],
  });

  const assistantContent = completion.choices[0]?.message?.content ?? 'No response generated.';

  logger.info('Legal chat response generated', {
    promptTokens: completion.usage?.prompt_tokens,
    completionTokens: completion.usage?.completion_tokens,
  });

  return assistantContent;
}
