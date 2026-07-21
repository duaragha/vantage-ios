import { NextResponse } from 'next/server';
import { prisma } from '@vantage/db';
import { componentLogger } from '@vantage/notify';
import { isAuthed } from '@/lib/auth';

const log = componentLogger('web/api/chat/threads');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const threadSelect = {
  id: true,
  title: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function GET(): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const threads = await prisma.chatThread.findMany({
      where: { archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: threadSelect,
    });
    return NextResponse.json({ threads });
  } catch (err) {
    log.error({ err }, 'chat thread list failed');
    return NextResponse.json({ error: 'chat threads unavailable', threads: [] }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    const empty = await prisma.chatThread.findFirst({
      where: { title: 'New chat', archivedAt: null, messages: { none: {} } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });
    const thread = empty
      ? await prisma.chatThread.update({
          where: { id: empty.id },
          data: { updatedAt: new Date() },
          select: threadSelect,
        })
      : await prisma.chatThread.create({
          data: { title: 'New chat' },
          select: threadSelect,
        });
    return NextResponse.json({ thread }, { status: 201 });
  } catch (err) {
    log.error({ err }, 'chat thread creation failed');
    return NextResponse.json({ error: 'could not create chat' }, { status: 500 });
  }
}
