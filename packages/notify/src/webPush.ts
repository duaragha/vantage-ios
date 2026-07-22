import webPush, { WebPushError, type Urgency } from 'web-push';

export interface AppPushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

export interface AppPushSubscriptionTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type AppPushFailureReason =
  | 'not-configured'
  | 'gone'
  | 'network'
  | 'rate-limited'
  | 'server-error'
  | 'client-error';

export interface AppPushFailure {
  ok: false;
  reason: AppPushFailureReason;
  statusCode?: number;
  description?: string;
}

export type AppPushResult = { ok: true; statusCode: number } | AppPushFailure;

export interface SendAppPushOptions {
  ttlSeconds?: number;
  urgency?: Urgency;
}

interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

function readVapidConfig(): VapidConfig | null {
  const publicKey = process.env['WEB_PUSH_PUBLIC_KEY'];
  const privateKey = process.env['WEB_PUSH_PRIVATE_KEY'];
  if (!publicKey || !privateKey) return null;
  return {
    publicKey,
    privateKey,
    subject:
      process.env['WEB_PUSH_SUBJECT'] ??
      process.env['DASHBOARD_BASE_URL'] ??
      'https://vantagee.up.railway.app',
  };
}

export function isAppPushConfigured(): boolean {
  return readVapidConfig() !== null;
}

/** Send one standards-based Web Push message to one Vantage installation. */
export async function sendAppPush(
  subscription: AppPushSubscriptionTarget,
  payload: AppPushPayload,
  options: SendAppPushOptions = {},
): Promise<AppPushResult> {
  const vapid = readVapidConfig();
  if (!vapid) return { ok: false, reason: 'not-configured' };

  try {
    const result = await webPush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      {
        vapidDetails: vapid,
        TTL: options.ttlSeconds ?? 6 * 60 * 60,
        urgency: options.urgency ?? 'normal',
        timeout: 15_000,
      },
    );
    return { ok: true, statusCode: result.statusCode };
  } catch (error) {
    if (error instanceof WebPushError) {
      const statusCode = error.statusCode;
      const reason: AppPushFailureReason =
        statusCode === 404 || statusCode === 410
          ? 'gone'
          : statusCode === 429
            ? 'rate-limited'
            : statusCode >= 500
              ? 'server-error'
              : 'client-error';
      return {
        ok: false,
        reason,
        statusCode,
        description: error.body || error.message,
      };
    }
    return {
      ok: false,
      reason: 'network',
      description: error instanceof Error ? error.message : String(error),
    };
  }
}
