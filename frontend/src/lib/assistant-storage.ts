/**
 * Where the assistant page remembers which conversation is open.
 *
 * The messages themselves live on the server; the page only needs the id to
 * get them back after navigating to another page or reloading. sessionStorage
 * rather than localStorage on purpose: it lasts for the tab and no longer, so a
 * shared machine does not reopen one person's HR questions in the next
 * person's browser. The key carries the user id as a second guard, and signing
 * out clears every entry regardless.
 */

const PREFIX = 'hrm.assistant.conversation:';

export function conversationStorageKey(userId: string): string {
  return `${PREFIX}${userId}`;
}

export function readStoredConversation(key: string): string | undefined {
  try {
    return sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeConversation(key: string, conversationId: string | null): void {
  try {
    if (conversationId) sessionStorage.setItem(key, conversationId);
    else sessionStorage.removeItem(key);
  } catch {
    // Storage can be unavailable (private mode, quota). The conversation is
    // still on the server; only the shortcut back to it is lost.
  }
}

/** Called on sign-out, so nothing points at the previous user's conversation. */
export function forgetAssistantConversations(): void {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(PREFIX)) sessionStorage.removeItem(key);
    }
  } catch {
    // Nothing stored, nothing to forget.
  }
}
