'use client';

import * as React from 'react';
import { motion } from 'motion/react';
import { ExternalLink, MessageSquare, Plus, Send } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FrostedPanel } from '@/components/FrostedPanel';
import { normalizeStoredChatCitations, type ChatCitation } from '@/lib/chatCitations';
import { fmtTimeAgo } from '@/lib/format';
import { MAX_CHAT_MESSAGE_CHARS } from '@/lib/chatInput';
import { cn } from '@/lib/utils';

export interface ChatThreadView {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageView {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  citations: ChatCitation[];
}

interface ChatClientProps {
  initialThreads: ChatThreadView[];
  initialThreadId: number | null;
  initialMessages: ChatMessageView[];
}

interface ThreadPayload {
  id: number;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const markdownComponents: Components = {
  h1: ({ node: _node, ...props }) => (
    <h1 className="mb-2 mt-4 text-lg font-semibold first:mt-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mb-2 mt-4 text-base font-semibold first:mt-0" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mb-1.5 mt-3 text-sm font-semibold first:mt-0" {...props} />
  ),
  p: ({ node: _node, ...props }) => (
    <p className="my-2 leading-relaxed first:mt-0 last:mb-0" {...props} />
  ),
  ul: ({ node: _node, ...props }) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
  ol: ({ node: _node, ...props }) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
  li: ({ node: _node, ...props }) => <li className="pl-0.5 leading-relaxed" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="my-3 border-l-2 border-[var(--cc-accent)]/45 pl-3 text-foreground/70"
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="my-3 w-full overflow-x-auto rounded-md border border-white/[0.08]">
      <table className="w-full caption-bottom text-left text-xs" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => (
    <thead className="border-b border-white/[0.1] bg-white/[0.04]" {...props} />
  ),
  tr: ({ node: _node, ...props }) => (
    <tr className="border-b border-white/[0.07] last:border-b-0" {...props} />
  ),
  th: ({ node: _node, ...props }) => (
    <th
      className="h-9 whitespace-nowrap px-3 py-2 align-middle font-mono text-[10px] uppercase text-foreground/70"
      {...props}
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="whitespace-nowrap px-3 py-2 align-middle text-foreground/85" {...props} />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className="my-3 max-w-full overflow-x-auto rounded-md border border-white/[0.08] bg-black/45 p-3 font-mono text-xs leading-relaxed"
      {...props}
    />
  ),
  code: ({ node: _node, className, ...props }) => (
    <code
      className={cn(
        className,
        className
          ? 'font-mono text-xs'
          : 'rounded bg-white/[0.08] px-1 py-0.5 font-mono text-[0.9em] text-[var(--cc-accent)]',
      )}
      {...props}
    />
  ),
  a: ({ node: _node, href, ...props }) => (
    <a
      href={href}
      className="text-[var(--cc-accent)] underline decoration-[var(--cc-accent)]/40 underline-offset-2 hover:decoration-[var(--cc-accent)]"
      {...(href?.startsWith('http') ? { target: '_blank', rel: 'noreferrer' } : {})}
      {...props}
    />
  ),
};

function toThread(payload: ThreadPayload): ChatThreadView {
  return {
    id: payload.id,
    title: payload.title,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

function sourceLabel(citation: ChatCitation): string {
  if (citation.title) return citation.title;
  if (citation.url) {
    try {
      return new URL(citation.url).hostname.replace(/^www\./, '');
    } catch {
      return citation.url;
    }
  }
  return `Article ${citation.articleId ?? '?'}`;
}

function AssistantContent({ content }: { content: string }): React.ReactElement {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </div>
  );
}

function Citations({ citations }: { citations: ChatCitation[] }): React.ReactElement | null {
  if (citations.length === 0) return null;

  return (
    <div className="mt-3 border-t border-white/[0.06] pt-2">
      <div className="mb-1.5 font-mono text-[9px] uppercase text-muted-foreground/70">Sources</div>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation, index) =>
          citation.url ? (
            <a
              key={`${citation.url}-${index}`}
              href={citation.url}
              target="_blank"
              rel="noreferrer"
              title={citation.quote}
              className="inline-flex max-w-full items-center gap-1 rounded-md border border-white/[0.09] bg-black/30 px-2 py-1 font-mono text-[10px] text-foreground/70 transition hover:border-[var(--cc-accent)]/35 hover:text-[var(--cc-accent)]"
            >
              <span className="max-w-[34ch] truncate">{sourceLabel(citation)}</span>
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <details
              key={`${citation.articleId}-${index}`}
              className="group max-w-full rounded-md border border-white/[0.09] bg-black/30 text-muted-foreground"
            >
              <summary className="max-w-[36ch] cursor-pointer list-none truncate px-2 py-1 font-mono text-[10px] marker:hidden">
                {sourceLabel(citation)}
              </summary>
              <p className="max-w-sm border-t border-white/[0.06] px-2 py-2 text-xs leading-relaxed text-foreground/75">
                {citation.quote}
              </p>
            </details>
          ),
        )}
      </div>
    </div>
  );
}

export function ChatClient({
  initialThreads,
  initialThreadId,
  initialMessages,
}: ChatClientProps): React.ReactElement {
  const [threads, setThreads] = React.useState<ChatThreadView[]>(initialThreads);
  const [activeThreadId, setActiveThreadId] = React.useState<number | null>(initialThreadId);
  const [messages, setMessages] = React.useState<ChatMessageView[]>(initialMessages);
  const [draft, setDraft] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [loadingThread, setLoadingThread] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const requestIdRef = React.useRef(0);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages.length]);

  const createThread = async (): Promise<ChatThreadView> => {
    const response = await fetch('/api/chat/threads', { method: 'POST' });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `request failed (${response.status})`);
    }
    const body = (await response.json()) as { thread: ThreadPayload };
    const thread = toThread(body.thread);
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    return thread;
  };

  const startNewChat = async (): Promise<void> => {
    if (submitting || loadingThread) return;
    setError(null);
    setLoadingThread(true);
    requestIdRef.current += 1;
    try {
      const thread = await createThread();
      setActiveThreadId(thread.id);
      setMessages([]);
      setDraft('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not create chat');
    } finally {
      setLoadingThread(false);
    }
  };

  const loadThread = async (threadId: number): Promise<void> => {
    if (threadId === activeThreadId || submitting || loadingThread) return;
    const requestId = ++requestIdRef.current;
    setError(null);
    setLoadingThread(true);
    try {
      const response = await fetch(`/api/chat?threadId=${threadId}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${response.status})`);
      }
      const body = (await response.json()) as {
        thread: ThreadPayload | null;
        messages: Array<{
          id: number;
          role: string;
          content: string;
          createdAt: string;
          citations: unknown;
        }>;
      };
      if (requestId !== requestIdRef.current || !body.thread) return;
      setActiveThreadId(body.thread.id);
      setMessages(
        body.messages
          .filter((message) => message.role === 'user' || message.role === 'assistant')
          .map((message) => ({
            id: message.id,
            role: message.role as 'user' | 'assistant',
            content: message.content,
            createdAt: message.createdAt,
            citations: normalizeStoredChatCitations(message.citations),
          })),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not load chat');
    } finally {
      if (requestId === requestIdRef.current) setLoadingThread(false);
    }
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || submitting || loadingThread) return;
    setSubmitting(true);
    setError(null);

    let threadId = activeThreadId;
    try {
      if (threadId === null) {
        const thread = await createThread();
        threadId = thread.id;
        setActiveThreadId(threadId);
        setMessages([]);
      }

      const optimistic: ChatMessageView = {
        id: Date.now() * -1,
        role: 'user',
        content: trimmed,
        createdAt: new Date().toISOString(),
        citations: [],
      };
      setMessages((current) => [...current, optimistic]);
      setDraft('');

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: trimmed, threadId }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `request failed (${response.status})`);
      }
      const body = (await response.json()) as {
        thread: ThreadPayload;
        user: { id: number; content: string; createdAt: string };
        assistant: { id: number; content: string; createdAt: string; citations: unknown };
        citations: unknown;
      };
      const updatedThread = toThread(body.thread);
      setThreads((current) => [
        updatedThread,
        ...current.filter((item) => item.id !== updatedThread.id),
      ]);
      setMessages((current) => [
        ...current.filter((message) => message.id !== optimistic.id),
        {
          id: body.user.id,
          role: 'user',
          content: body.user.content,
          createdAt: body.user.createdAt,
          citations: [],
        },
        {
          id: body.assistant.id,
          role: 'assistant',
          content: body.assistant.content,
          createdAt: body.assistant.createdAt,
          citations: normalizeStoredChatCitations(body.citations ?? body.assistant.citations),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'chat failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
      <FrostedPanel padding="none" className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="flex w-56 shrink-0 flex-col border-r border-white/[0.07] bg-black/15">
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.07] px-3">
            <span className="font-mono text-[10px] uppercase text-muted-foreground">Threads</span>
            <button
              type="button"
              onClick={() => void startNewChat()}
              disabled={submitting || loadingThread}
              aria-label="New chat"
              title="New chat"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-white/[0.06] hover:text-[var(--cc-accent)] disabled:opacity-40"
            >
              <Plus className="size-4" />
            </button>
          </div>
          <nav aria-label="Chat threads" className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {threads.length === 0 ? (
              <div className="px-3 py-4 font-mono text-[10px] text-muted-foreground">
                No conversations yet.
              </div>
            ) : (
              threads.map((thread) => (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => void loadThread(thread.id)}
                  disabled={submitting || loadingThread}
                  aria-current={thread.id === activeThreadId ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-start gap-2 border-l-2 px-3 py-2.5 text-left transition disabled:opacity-50',
                    thread.id === activeThreadId
                      ? 'border-[var(--cc-accent)] bg-[var(--cc-accent)]/[0.08] text-foreground'
                      : 'border-transparent text-muted-foreground hover:bg-white/[0.035] hover:text-foreground/85',
                  )}
                >
                  <MessageSquare className="mt-0.5 size-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-medium">{thread.title}</span>
                    <span className="mt-0.5 block font-mono text-[9px] text-muted-foreground/60">
                      {fmtTimeAgo(thread.updatedAt)}
                    </span>
                  </span>
                </button>
              ))
            )}
          </nav>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-5 py-5 touch-pan-y"
          >
            {loadingThread ? (
              <div className="flex h-full items-center justify-center font-mono text-[10px] uppercase text-muted-foreground">
                Loading conversation...
              </div>
            ) : messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <div className="font-mono text-[10px] uppercase text-muted-foreground">
                  Empty conversation
                </div>
                <p className="max-w-md text-sm text-muted-foreground">
                  Ask about a holding, goal, discovery score, or recent market event.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {messages.map((message) => (
                  <motion.div
                    key={message.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ type: 'spring', stiffness: 240, damping: 26 }}
                    className={cn(
                      'flex',
                      message.role === 'user' ? 'justify-end' : 'justify-start',
                    )}
                  >
                    <div
                      className={cn(
                        'min-w-0 max-w-[82%] rounded-lg border px-4 py-3 text-sm',
                        message.role === 'user'
                          ? 'border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 text-foreground'
                          : 'border-white/[0.08] bg-white/[0.03] text-foreground/90',
                      )}
                    >
                      {message.role === 'assistant' ? (
                        <AssistantContent content={message.content} />
                      ) : (
                        <div className="whitespace-pre-wrap break-words leading-relaxed">
                          {message.content}
                        </div>
                      )}
                      <Citations citations={message.citations} />
                      <div className="mt-2 font-mono text-[10px] text-muted-foreground/60">
                        {fmtTimeAgo(message.createdAt)}
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            )}
          </div>
        </section>
      </FrostedPanel>

      <form onSubmit={submit} className="flex shrink-0 gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={MAX_CHAT_MESSAGE_CHARS}
          placeholder="Ask something..."
          disabled={submitting || loadingThread}
          className="min-h-12 min-w-0 flex-1 rounded-md border border-white/[0.08] bg-black/30 px-4 py-3 text-base outline-none transition focus:border-[var(--cc-accent)]/60 focus:ring-2 focus:ring-[var(--cc-accent)]/25 disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={submitting || loadingThread || !draft.trim()}
          className="inline-flex min-h-12 shrink-0 items-center gap-2 rounded-md border border-[var(--cc-accent)]/30 bg-[var(--cc-accent)]/10 px-4 py-3 font-mono text-xs uppercase text-[var(--cc-accent)] transition hover:bg-[var(--cc-accent)]/15 disabled:opacity-40"
        >
          {submitting ? (
            'Thinking...'
          ) : (
            <>
              <Send className="size-3.5" />
              Send
            </>
          )}
        </button>
      </form>

      {error && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 font-mono text-xs text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}
