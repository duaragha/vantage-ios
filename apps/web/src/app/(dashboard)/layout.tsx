/**
 * Dashboard shell — sidebar + kill-switch banner + content + footer disclaimer.
 *
 * Runs on the server so we can read UserSettings for the kill-switch banner
 * without an extra round-trip.
 */

import * as React from 'react';
import { getSettings } from '@vantage/db';
import { AlertTriangle } from 'lucide-react';
import { componentLogger } from '@vantage/notify';
import { Sidebar } from '@/components/Sidebar';
import { MobileNavigation } from '@/components/MobileNavigation';

// This layout reads the live kill-switch setting. Keeping the whole dashboard
// request-rendered also prevents Prisma from running during `next build`.
export const dynamic = 'force-dynamic';
const log = componentLogger('web/dashboard-layout');

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.ReactElement> {
  let killSwitchOn = false;
  let controlsUnavailable = false;
  try {
    const settings = await getSettings();
    killSwitchOn = settings?.killSwitch === true;
  } catch (err) {
    controlsUnavailable = true;
    log.error({ err }, 'dashboard controls unavailable');
  }

  return (
    <div className="relative min-h-dvh bg-background text-foreground">
      {/* Ambient gradient wash — subtle cyan + electric blue smeared across the background */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/3 h-[500px] w-[500px] rounded-full bg-[var(--cc-accent)]/[0.06] blur-3xl" />
        <div className="absolute top-1/2 right-0 h-[400px] w-[400px] rounded-full bg-blue-500/[0.05] blur-3xl" />
      </div>

      <div className="flex">
        <Sidebar />
        <MobileNavigation />

        <div className="flex min-h-dvh min-w-0 flex-1 flex-col pt-[calc(3.5rem+env(safe-area-inset-top))] lg:min-h-screen lg:pt-0">
          {killSwitchOn && (
            <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-200 sm:px-6">
              <AlertTriangle className="size-4 shrink-0" />
              <span>
                <strong className="font-semibold">Kill switch active.</strong> All non-user LLM
                calls are paused. Flip it off on the Settings page once you&rsquo;ve addressed spend
                / behavior.
              </span>
            </div>
          )}
          {controlsUnavailable && (
            <div className="flex items-start gap-2 border-b border-rose-500/30 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-200 sm:px-6">
              <AlertTriangle className="size-4 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">System controls unavailable.</strong> Kill-switch
                state could not be verified. Treat automated analysis as unavailable until the
                database reconnects.
              </span>
            </div>
          )}

          <main className="dashboard-main min-w-0 flex-1 pb-[calc(4.75rem+env(safe-area-inset-bottom))] lg:pb-0">
            {children}
          </main>

          <footer className="border-t border-white/[0.04] px-4 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-4 text-center font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground/60 sm:px-6 sm:text-[10px] sm:tracking-[0.25em] lg:pb-4">
            Not investment advice. Personal research tool.
          </footer>
        </div>
      </div>
    </div>
  );
}
