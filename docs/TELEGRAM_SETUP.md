# Telegram bot setup

Vantage uses a private Telegram bot for alerts + digests. One-time
setup below. All of it happens in the Telegram app and your shell — no code
changes needed.

## 1. Create the bot

1. Open Telegram. Search for **@BotFather** and start a chat.
2. Send `/newbot`.
3. Name it (shown in chats): `Vantage` is fine.
4. Pick a username ending in `bot` (must be globally unique):
   `raghav_vantage_bot` or similar.
5. BotFather replies with:

   ```
   Use this token to access the HTTP API:
   1234567890:ABCDEF...<long-token>
   ```

   Copy that token.

6. Paste it into `.env`:

   ```
   TELEGRAM_BOT_TOKEN=1234567890:ABCDEF...
   ```

Optional hardening with BotFather:

- `/setprivacy` → `Enable` (the bot only sees messages addressed to it).
- `/setjoingroups` → `Disable` (prevents anyone from adding it to groups).
- `/setdescription`, `/setuserpic` — cosmetic.

## 2. Capture your chat_id

The bot can only send you messages after you've messaged it first.

1. In Telegram, open the bot's chat and send any message — `hi` works.
2. Back in your shell, hit `getUpdates` to find the chat id:

   ```bash
   # Replace <TOKEN> with your TELEGRAM_BOT_TOKEN
   curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq .
   ```

   Look for `"chat": { "id": <number>, ... }`. For a private chat this is
   a positive integer (e.g. `123456789`). For groups it's negative.

3. Paste it into `.env`:

   ```
   TELEGRAM_CHAT_ID=123456789
   ```

## 3. Verify end-to-end

Recreate the worker so it picks up the new env. A plain `compose restart` does
not reload environment values:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  up -d --no-deps --force-recreate worker
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  logs --tail 50 worker
```

Look for one of:

- `[notify/telegram] verifyChatId: ok` — all good.
- `[notify/telegram] verifyChatId: getMe failed` / `getChat failed` — the
  token or chat_id is wrong.

To fire a real message through Vantage, call the worker's authenticated Telegram
smoke endpoint inside the remote container. The secret stays inside the
container and is not printed:

```bash
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml \
  exec -T worker sh -lc \
  'wget -qO- --header="x-worker-secret: $WORKER_SECRET" --post-data="" \
    http://127.0.0.1:3001/jobs/telegram/test'
```

The response must contain `{"ok":true,"messageId":...}`, and the bot chat must
receive the timestamped test message within a few seconds. If not:

- Wrong token → HTTP 401 in the worker logs.
- Wrong chat_id → HTTP 400 `chat not found` in the worker logs.
- You haven't messaged the bot first → same 400.

## 4. Don't share the bot

The token is equivalent to a password. Don't paste it in chats, screenshots,
or commit it. `.env` is gitignored — keep it that way. Rotate with
BotFather's `/revoke` if it ever leaks.
