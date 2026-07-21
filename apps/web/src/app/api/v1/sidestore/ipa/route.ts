import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEMAGIC_API = 'https://api.codemagic.io';
const APP_ID = '6a5504d651238a3fa7259752';

export async function GET(request: Request): Promise<NextResponse> {
  const token = process.env['CODEMAGIC_API_TOKEN']?.trim();
  if (!token) {
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }

  const buildId = new URL(request.url).searchParams.get('build');
  if (!buildId || !/^[a-f0-9]{24}$/.test(buildId)) {
    return NextResponse.json({ error: 'bad build id' }, { status: 400 });
  }

  try {
    const response = await fetch(`${CODEMAGIC_API}/builds/${buildId}`, {
      headers: { 'x-auth-token': token },
      cache: 'no-store',
    });
    if (!response.ok) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const data = (await response.json()) as {
      build?: {
        appId?: string;
        artefacts?: Array<{ name: string; url?: string }>;
      };
    };
    if (data.build?.appId !== APP_ID) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const ipa = (data.build.artefacts ?? []).find((artifact) => artifact.name.endsWith('.ipa'));
    if (!ipa?.url) {
      return NextResponse.json({ error: 'no ipa' }, { status: 404 });
    }

    const artifactResponse = await fetch(`${CODEMAGIC_API}${new URL(ipa.url).pathname}`, {
      headers: { 'x-auth-token': token },
      redirect: 'manual',
    });
    const redirect = artifactResponse.headers.get('location');
    if (redirect) return NextResponse.redirect(redirect, 302);

    const body = await artifactResponse.text();
    const match = body.match(/href="([^"]+)"/);
    if (match?.[1]) return NextResponse.redirect(match[1], 302);

    return NextResponse.json({ error: 'artifact unavailable' }, { status: 502 });
  } catch {
    return NextResponse.json({ error: 'artifact unavailable' }, { status: 502 });
  }
}
