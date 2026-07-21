/**
 * /chat — Claude-backed Q&A with pgvector retrieval.
 *
 * Simple non-streaming UX. ChatMessage table is the source of truth; we
 * render history on load and append server responses as they come back.
 */

import * as React from 'react';
import { prisma } from '@vantage/db';
import { normalizeStoredChatCitations } from '@/lib/chatCitations';
import { ChatClient, type ChatMessageView, type ChatThreadView } from './ChatClient';
import { DbErrorBanner } from '@/components/DbErrorBanner';

export const dynamic = 'force-dynamic';

export default async function ChatPage(): Promise<React.ReactElement> {
  let initialThreads: ChatThreadView[] = [];
  let initialMessages: ChatMessageView[] = [];
  let initialThreadId: number | null = null;
  let dbError: string | null = null;
  try {
    const threads = await prisma.chatThread.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
    initialThreads = threads.map((thread) => ({
      ...thread,
      createdAt: thread.createdAt.toISOString(),
      updatedAt: thread.updatedAt.toISOString(),
    }));
    initialThreadId = initialThreads[0]?.id ?? null;

    if (initialThreadId !== null) {
      const rows = await prisma.chatMessage.findMany({
        where: { threadId: initialThreadId },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });
      initialMessages = rows.reverse().map((row) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        content: row.content,
        createdAt: row.createdAt.toISOString(),
        citations: normalizeStoredChatCitations(row.citations),
      }));
    }
  } catch (err) {
    dbError = err instanceof Error ? err.message : 'database unreachable';
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem-env(safe-area-inset-top)-4.75rem-env(safe-area-inset-bottom))] min-h-[30rem] flex-col px-4 py-4 sm:px-6 lg:h-[calc(100vh-5rem)] lg:px-8 lg:py-6">
      <header className="mb-4 flex-shrink-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
          chat
        </div>
        <h1 className="cc-page-title mt-2">Ask</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Retrieval-augmented over your articles + thesis evaluations. Cites what it used.
        </p>
      </header>

      <DbErrorBanner message={dbError} />

      <ChatClient
        initialThreads={initialThreads}
        initialThreadId={initialThreadId}
        initialMessages={initialMessages}
      />
    </div>
  );
}
