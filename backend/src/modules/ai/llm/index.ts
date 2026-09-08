import { env } from '../../../config/env.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { FakeLlmProvider } from './fake.provider.js';
import { OpenAiCompatibleProvider } from './openai.provider.js';
import type { LlmProvider } from './types.js';

/**
 * Chooses the provider from configuration.
 *
 * The rest of the application receives an `LlmProvider` and never learns which
 * one it got. Tests replace it with `setLlmProvider(new FakeLlmProvider())` —
 * a seam that exists precisely so the security tests can force the model to
 * attempt something it should not be allowed to do.
 */
function build(): LlmProvider {
  const config = {
    apiKey: env.AI_API_KEY ?? '',
    baseUrl: env.AI_BASE_URL,
    model: env.AI_MODEL,
    timeoutMs: env.AI_TIMEOUT_MS,
  };

  switch (env.AI_PROVIDER) {
    case 'openai':
      return new OpenAiCompatibleProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    case 'fake':
    default:
      return new FakeLlmProvider();
  }
}

let provider: LlmProvider = build();

export function getLlmProvider(): LlmProvider {
  return provider;
}

/** Test seam. Not used by application code. */
export function setLlmProvider(next: LlmProvider): void {
  provider = next;
}

export function resetLlmProvider(): void {
  provider = build();
}

export * from './types.js';
export { AnthropicProvider } from './anthropic.provider.js';
export { FakeLlmProvider } from './fake.provider.js';
export { OpenAiCompatibleProvider } from './openai.provider.js';
