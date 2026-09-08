import { z } from 'zod';

export const askAssistantSchema = z.object({
  // Capped at 2000 characters. Long inputs cost tokens, and a very long message
  // is a common wrapper for prompt-injection payloads — there is no legitimate
  // HR question that needs more.
  question: z.string().trim().min(1, 'Ask a question').max(2000),
  conversationId: z.string().uuid().optional(),
});

export const conversationParams = z.object({
  id: z.string().uuid(),
});

export type AskAssistantInput = z.infer<typeof askAssistantSchema>;
