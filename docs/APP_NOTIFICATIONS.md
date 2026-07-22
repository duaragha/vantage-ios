# Vantage app notifications

Vantage sends its own phone notifications for buy recommendations, rebalances,
exceptional catalyst opportunities, and optional scheduled briefings. Telegram
is not part of this delivery path.

## Install on iPhone

1. Open `https://vantagee.up.railway.app` in Safari and sign in.
2. Tap Share, then Add to Home Screen.
3. Open the new Vantage icon.
4. Open Settings → Notifications and tap Enable notifications.
5. Tap Send test. The notification should appear as Vantage and open Settings.

iOS exposes Web Push only to Home Screen web apps. The LiveContainer IPA can
remain installed for ordinary use, but LiveContainer guest apps cannot receive
remote push while closed. The Home Screen Vantage install is therefore the
notification-capable mobile app.

## Railway configuration

Generate one VAPID key pair. Store the public key on both `web` and `worker`,
and the private key only on `worker`:

```dotenv
# web
WEB_PUSH_PUBLIC_KEY=<public key>

# worker
WEB_PUSH_PUBLIC_KEY=<same public key>
WEB_PUSH_PRIVATE_KEY=<private key>
WEB_PUSH_SUBJECT=https://vantagee.up.railway.app
```

Do not rotate the pair casually. Existing device subscriptions are bound to
it and must be re-enabled after a rotation.

## Delivery flow

The authenticated web app registers `/sw.js`, asks for notification permission
only after the user taps Enable, and saves the browser subscription in Postgres.
The worker writes recommendation notifications to `AppNotificationDelivery`.
The 30-second dispatcher signs each push with VAPID, retries transient failures,
disables expired device endpoints, and retains sent/dead rows for 30/90 days.

The exceptional-opportunity engine checks for new eligible catalyst events every
five minutes during market hours. All research still lands in Insights when a
phone-notification preference is muted.

## Verification

- Settings must show `Connected` on the Home Screen Vantage app.
- Send test must return success and produce a real iOS notification.
- Worker `/health/deep` should report `appNotifications.configured: true`, at
  least one active subscription, and no dead deliveries.
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` may remain unset.

Platform references:

- WebKit: <https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/>
- LiveContainer limitations: <https://github.com/LiveContainer/LiveContainer>
