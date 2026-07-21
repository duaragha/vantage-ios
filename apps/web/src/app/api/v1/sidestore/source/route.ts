import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CODEMAGIC_API = 'https://api.codemagic.io';
const APP_ID = '6a5504d651238a3fa7259752';
const DEFAULT_ORIGIN = 'https://raghavsgamingpc.tail4d6220.ts.net:3500';

interface CodemagicArtifact {
  name: string;
  size?: number;
  url?: string;
  version?: string;
  versionName?: string;
}

interface CodemagicBuild {
  _id: string;
  status: string;
  branch: string;
  finishedAt?: string;
  version?: string;
  commit?: { commitMessage?: string };
  artefacts?: CodemagicArtifact[];
}

function fallbackVersion(finishedAt: string): string {
  const digits = finishedAt.replace(/[^0-9]/g, '').slice(0, 12);
  return `1.${digits.slice(0, 4)}.${digits.slice(4, 11)}`;
}

function releaseNotes(commitMessage: string | undefined, buildId: string): string {
  const cleaned = (
    (commitMessage ?? '').split(/\n\s*(?:Co-Authored-By:|🤖|Generated with)/i)[0] ?? ''
  ).trim();
  return cleaned || `Codemagic build ${buildId.slice(-6)}`;
}

function publicOrigin(request: Request): string {
  const configured =
    process.env['DASHBOARD_BASE_URL']?.trim() || process.env['TAILSCALE_BASE_URL']?.trim();
  if (configured) return configured.replace(/\/$/, '');

  const requestOrigin = new URL(request.url).origin;
  return requestOrigin.includes('localhost') || requestOrigin.includes('127.0.0.1')
    ? DEFAULT_ORIGIN
    : requestOrigin;
}

export async function GET(request: Request): Promise<NextResponse> {
  const token = process.env['CODEMAGIC_API_TOKEN']?.trim();
  if (!token) {
    return NextResponse.json({ error: 'source unavailable' }, { status: 503 });
  }

  let latest: CodemagicBuild | undefined;
  try {
    const response = await fetch(`${CODEMAGIC_API}/builds?appId=${APP_ID}`, {
      headers: { 'x-auth-token': token },
      next: { revalidate: 300 },
    });
    if (!response.ok) throw new Error(`Codemagic returned ${response.status}`);

    const data = (await response.json()) as { builds?: CodemagicBuild[] };
    latest = (data.builds ?? []).find(
      (build) =>
        build.status === 'finished' &&
        (build.artefacts ?? []).some((artifact) => artifact.name.endsWith('.ipa')),
    );
  } catch {
    return NextResponse.json({ error: 'source unavailable' }, { status: 503 });
  }

  if (!latest) {
    return NextResponse.json({ error: 'no builds' }, { status: 404 });
  }

  const ipa = (latest.artefacts ?? []).find((artifact) => artifact.name.endsWith('.ipa'));
  const origin = publicOrigin(request);
  const finishedAt = latest.finishedAt ?? new Date(0).toISOString();
  const iconUrl = `${origin}/icon-512.png?v=${latest._id}`;

  return NextResponse.json(
    {
      name: 'Vantage',
      identifier: 'com.raghav.vantage.source',
      subtitle: 'personal portfolio intelligence',
      iconURL: iconUrl,
      apps: [
        {
          name: 'Vantage',
          bundleIdentifier: 'com.raghav.vantage',
          developerName: 'Raghav Dua',
          version:
            latest.version ?? ipa?.versionName ?? ipa?.version ?? fallbackVersion(finishedAt),
          versionDate: finishedAt,
          versionDescription: releaseNotes(latest.commit?.commitMessage, latest._id),
          downloadURL: `${origin}/api/v1/sidestore/ipa?build=${latest._id}`,
          localizedDescription:
            'Private portfolio, research, goals, discovery, and trading intelligence.',
          iconURL: iconUrl,
          size: ipa?.size ?? 0,
          tintColor: '5EEAD4',
        },
      ],
    },
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  );
}
