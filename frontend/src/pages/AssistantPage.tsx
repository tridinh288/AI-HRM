import { useMutation, useQuery } from '@tanstack/react-query';
import { Bot, MessageSquarePlus, Send, ShieldAlert, ShieldCheck, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Badge, Button, Card, CardHeader, Input, PageHeader, Spinner } from '../components/ui';
import { useAuth } from '../features/auth/AuthContext';
import { api, fetchData, getErrorMessage } from '../lib/api';
import {
  conversationStorageKey,
  readStoredConversation,
  storeConversation,
} from '../lib/assistant-storage';
import type {
  AiAnswer,
  AiCapabilities,
  AiConversationDetail,
  AiConversationMessage,
  AiToolCall,
} from '../lib/types';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: AiToolCall[];
  isError?: boolean;
}

const EMPLOYEE_SUGGESTIONS = [
  'How many days of leave do I have left?',
  'What is my attendance summary this month?',
  'Show me my leave requests',
];

const HR_SUGGESTIONS = [
  'How many employees are in each department?',
  'List the members of the Sales department',
  'How many pending leave requests are there?',
  'Who was late this month?',
];

/**
 * Renders an assistant reply as markdown.
 *
 * The model is told to present people as a table, and a table shown as raw
 * pipes is not a list of people. GFM is what supplies tables; the element map
 * keeps the result inside the chat bubble — a full-width table scrolls in its
 * own box rather than pushing the page sideways. User messages stay plain
 * text: nothing they type should be interpreted as markup.
 */
function AssistantMarkdown({ content }: { content: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="break-words [&:not(:last-child)]:mb-2">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5">{children}</ol>,
        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
        code: ({ children }) => (
          <code className="rounded bg-slate-200/70 px-1 font-mono text-[12px]">{children}</code>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto rounded-lg ring-1 ring-slate-200">
            <table className="min-w-full text-left text-xs">{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead className="bg-slate-200/60">{children}</thead>,
        th: ({ children }) => (
          <th className="whitespace-nowrap px-2.5 py-1.5 font-semibold text-slate-700">{children}</th>
        ),
        td: ({ children }) => (
          <td className="whitespace-nowrap border-t border-slate-200 px-2.5 py-1.5 tabular-nums">
            {children}
          </td>
        ),
      }}
    >
      {content}
    </Markdown>
  );
}

/** A stored message, in the shape the chat renders. */
function toChatMessage(message: AiConversationMessage): ChatMessage {
  return {
    id: message.id,
    role: message.role === 'USER' ? 'user' : 'assistant',
    content: message.content,
    ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
  };
}

export function AssistantPage() {
  const { isHrOrAdmin, user } = useAuth();
  const storageKey = user ? conversationStorageKey(user.id) : null;

  // Messages added on this visit. Anything from before it comes from the server.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  // Navigating away unmounts this page and its state with it. The server has
  // kept every message, so remembering just the id is enough to pick the
  // conversation back up — after a route change or a reload alike.
  const [conversationId, setConversationId] = useState<string | undefined>(() =>
    storageKey ? readStoredConversation(storageKey) : undefined,
  );
  // A conversation begun on this visit is already on screen; only one that was
  // open before the page mounted needs fetching.
  const [startedHere, setStartedHere] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const restore = useQuery({
    queryKey: ['ai', 'conversation', conversationId],
    queryFn: async () => {
      try {
        return await fetchData<AiConversationDetail>(`/ai/conversations/${conversationId}`);
      } catch (error) {
        // The stored id no longer resolves (deleted, or another account's).
        // Forget it rather than keep failing on a conversation nobody chose.
        if (storageKey) storeConversation(storageKey, null);
        throw error;
      }
    },
    enabled: Boolean(conversationId) && !startedHere,
    retry: false,
  });

  const restored: ChatMessage[] =
    conversationId && restore.data?.id === conversationId
      ? restore.data.messages.map(toChatMessage)
      : [];
  const shown = [...restored, ...messages];
  const restoring = Boolean(conversationId) && !startedHere && restore.isPending;
  // A conversation that failed to load is not continued: the next question
  // starts a fresh one.
  const activeConversationId = restore.isError ? undefined : conversationId;

  function startNewConversation() {
    setMessages([]);
    setConversationId(undefined);
    setStartedHere(false);
    if (storageKey) storeConversation(storageKey, null);
  }

  const capabilities = useQuery({
    queryKey: ['ai', 'capabilities'],
    queryFn: () => fetchData<AiCapabilities>('/ai/capabilities'),
    staleTime: 10 * 60 * 1000,
  });

  const ask = useMutation({
    mutationFn: async (question: string) => {
      const response = await api.post<{ data: AiAnswer }>('/ai/assistant', {
        question,
        conversationId: activeConversationId,
      });
      return response.data.data;
    },
    onSuccess: (answer) => {
      setStartedHere(true);
      setConversationId(answer.conversationId);
      if (storageKey) storeConversation(storageKey, answer.conversationId);
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: answer.answer,
          toolCalls: answer.toolCalls,
        },
      ]);
    },
    onError: (error) => {
      // A failed AI call is shown as a message rather than a toast: the failure
      // belongs in the conversation, where the question it failed to answer is.
      setMessages((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: getErrorMessage(error),
          isError: true,
        },
      ]);
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [shown.length, ask.isPending]);

  function submit(question: string) {
    const trimmed = question.trim();
    if (!trimmed || ask.isPending) return;

    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role: 'user', content: trimmed },
    ]);
    setInput('');
    ask.mutate(trimmed);
  }

  const suggestions = isHrOrAdmin ? HR_SUGGESTIONS : EMPLOYEE_SUGGESTIONS;

  return (
    <>
      <PageHeader
        title="HR Assistant"
        description="Ask about your own HR data — or, for HR and admins, about the company"
        action={
          shown.length > 0 ? (
            <Button
              variant="secondary"
              icon={<MessageSquarePlus className="h-4 w-4" />}
              onClick={startNewConversation}
              disabled={ask.isPending}
            >
              New conversation
            </Button>
          ) : undefined
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card padded={false} className="flex h-[36rem] flex-col">
          <div className="flex-1 space-y-4 overflow-y-auto p-5">
            {restoring && (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
                <Spinner className="h-4 w-4" />
                Picking up where you left off…
              </div>
            )}

            {shown.length === 0 && !restoring && (
              <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                <div className="rounded-xl bg-brand-50 p-3 text-brand-600">
                  <Bot className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-medium text-slate-800">Ask a question about HR data</p>
                  <p className="mt-1 max-w-sm text-sm text-slate-500">
                    The assistant cannot query the database directly. It picks from a set of
                    approved tools, and the server checks your permissions before any of them run.
                  </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => submit(suggestion)}
                      className="rounded-full border border-slate-200 px-3 py-1.5 text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {shown.map((message) => (
              <div
                key={message.id}
                className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}
              >
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600 px-4 py-2.5 text-sm text-white'
                      : message.isError
                        ? 'max-w-[85%] rounded-2xl rounded-bl-sm bg-rose-50 px-4 py-2.5 text-sm text-rose-800'
                        : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-slate-100 px-4 py-2.5 text-sm text-slate-800'
                  }
                >
                  <div className="mb-1 flex items-center gap-1.5 text-xs opacity-70">
                    {message.role === 'user' ? (
                      <User className="h-3 w-3" />
                    ) : (
                      <Bot className="h-3 w-3" />
                    )}
                    {message.role === 'user' ? 'You' : 'Assistant'}
                  </div>

                  {message.role === 'assistant' && !message.isError ? (
                    <AssistantMarkdown content={message.content} />
                  ) : (
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  )}

                  {/*
                    Every tool the model asked for is shown, allowed or refused.
                    An answer with no tool calls behind it is an answer with no
                    data behind it — surfacing that is the most practical defence
                    against a confident-sounding invented number.
                  */}
                  {message.toolCalls && message.toolCalls.length > 0 && (
                    <div className="mt-3 space-y-1 border-t border-slate-200 pt-2">
                      {message.toolCalls.map((call, index) => (
                        <div
                          key={`${call.name}-${index}`}
                          className="flex items-start gap-1.5 text-xs"
                        >
                          {call.allowed ? (
                            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                          ) : (
                            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-600" />
                          )}
                          <span className="min-w-0">
                            {/* The label is for people; the identifier the
                                model actually used stays one hover away. */}
                            <span
                              title={call.name}
                              className={call.title ? 'text-slate-700' : 'font-mono text-[11px] text-slate-600'}
                            >
                              {call.title ?? call.name}
                            </span>
                            {call.allowed ? (
                              <span className="ml-1 text-slate-400">({call.durationMs}ms)</span>
                            ) : (
                              <span className="ml-1 text-rose-600">
                                denied — {call.deniedReason}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {ask.isPending && (
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <Spinner className="h-4 w-4" />
                Thinking…
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit(input);
            }}
            className="flex gap-2 border-t border-slate-200 p-4"
          >
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="Ask about attendance, leave or headcount…"
              maxLength={2000}
              aria-label="Your question"
            />
            <Button
              type="submit"
              loading={ask.isPending}
              disabled={!input.trim()}
              icon={<Send className="h-4 w-4" />}
            >
              Send
            </Button>
          </form>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader
              title="What it can reach"
              description="Filtered by your role, on the server"
            />
            {capabilities.isPending ? (
              <Spinner />
            ) : capabilities.isError ? (
              <p className="text-sm text-slate-500">Could not load capabilities.</p>
            ) : (
              <>
                <div className="mb-3">
                  <Badge tone="info">provider: {capabilities.data.provider}</Badge>
                </div>
                <ul className="space-y-2">
                  {capabilities.data.tools.map((tool) => (
                    <li
                      key={tool.name}
                      title={`${tool.name} — ${tool.description}`}
                      className="flex items-center justify-between gap-2 text-xs"
                    >
                      <span className="text-slate-700">{tool.title}</span>
                      <Badge tone={tool.scope === 'self' ? 'neutral' : 'warning'}>
                        {tool.scope === 'self' ? 'only you' : 'company-wide'}
                      </Badge>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card className="bg-slate-50">
            <p className="text-xs font-medium text-slate-700">How this stays safe</p>
            <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
              <li>· The model never receives database access.</li>
              <li>· Tools are filtered by role before the model sees the list.</li>
              <li>· Personal tools take your identity from your token, not from the model.</li>
              <li>· No tool can return salary data.</li>
              <li>· Every call — allowed or refused — is written to an audit table.</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
