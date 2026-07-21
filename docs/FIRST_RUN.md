# First run — bootstrap + first digest

After `./infra/deploy-docker-to-pc.sh` completes from this workspace (see
[DEPLOY_WINDOWS.md](./DEPLOY_WINDOWS.md)), Vantage is running but has no
positions, no thesis history, and no articles. This doc walks through the
cold-start flow.

All endpoints are on the worker, which is loopback-only on the PC and protected
by `WORKER_SECRET`. Forward its loopback port over SSH in a second terminal:

```bash
ssh -N -L 3001:127.0.0.1:3001 docker-pc
```

Then pull the secret from `.env` in the project terminal:

```bash
# From the project root on this Linux machine:
WORKER_SECRET="$(grep -E '^WORKER_SECRET=' .env | cut -d= -f2-)"
```

All `curl` examples below assume `WORKER_SECRET` is set in that shell. Do not
print or paste it.

---

## 1. Add your current positions

Two options. Pick whichever is faster for you.

### Option A — dashboard (recommended for a handful of positions)

1. Browse to `https://raghavsgamingpc.tail4d6220.ts.net:3500/portfolio/add`.
2. Fill in ticker, shares, average cost, category, thesis pillars,
   risk factors. Submit.
3. Repeat per position.

### Option B — bulk CSV import

1. Browse to `https://raghavsgamingpc.tail4d6220.ts.net:3500/portfolio/import`.
2. Paste CSV with headers:

   ```csv
   ticker,shares,avgCost,category
   NVDA,10,450.25,core
   AAPL,25,175.00,core
   ```

3. Preview, confirm. Theses are left empty; bootstrap (step 2) populates
   them.

---

## 2. Bootstrap each ticker

`POST /jobs/bootstrap/:ticker` pulls 30 days of Finnhub news + the last 2
quarters of EDGAR filings + earnings calendar, synthesizes an initial
Thesis via Sonnet (if the Position has none), and runs a baseline
evaluation.

Runtime: ~10–30s per ticker depending on how chatty the news is.

```bash
# One ticker
curl -X POST http://localhost:3001/jobs/bootstrap/NVDA \
  -H "x-worker-secret: $WORKER_SECRET"

# All tickers you just added (bash):
for T in NVDA AAPL AMD QBTS; do
  echo "== $T =="
  curl -s -X POST "http://localhost:3001/jobs/bootstrap/$T" \
    -H "x-worker-secret: $WORKER_SECRET"
  echo
done
```

Watch the worker log in another terminal — you'll see Anthropic calls,
thesis synthesis, and a baseline `ThesisEvaluation` row written per
ticker. You can also tail via docker:

```powershell
docker --context gamingpc compose --env-file .env -f infra/docker-compose.yml logs --tail 200 worker
```

## 3. Verify in the dashboard

1. Go to `/portfolio`. Every row should show a thesis-health glow
   (Intact / Strengthening / Weakening / Broken).
2. Click any ticker → `/positions/<TICKER>`. You should see:
   - Pillars with per-pillar status + confidence
   - Risk factors list
   - Evaluation history (at least one entry from the bootstrap)
   - Linked articles

If a position still shows "no thesis", re-run bootstrap for that ticker.
Bootstrap is idempotent — it won't clobber an existing thesis unless
`force=1` is passed.

## 4. Trigger the first real digest

Morning digest (overnight + premarket + earnings today + catalysts):

```bash
curl -X POST http://localhost:3001/jobs/digest/morning \
  -H "x-worker-secret: $WORKER_SECRET"
```

Within a few seconds you should get a Telegram message. The footer shows
which sources responded and which failed (helpful signal if a data key
is stale).

Evening digest (recap + AH earnings + tomorrow calendar + thesis deltas):

```bash
curl -X POST http://localhost:3001/jobs/digest/evening \
  -H "x-worker-secret: $WORKER_SECRET"
```

Monthly allocation (budget → buy suggestions, caps-enforced):

```bash
curl -X POST http://localhost:3001/jobs/digest/monthly-allocation \
  -H "x-worker-secret: $WORKER_SECRET"
```

Weekly Opus deep-dive:

```bash
curl -X POST http://localhost:3001/jobs/digest/weekly-deepdive \
  -H "x-worker-secret: $WORKER_SECRET"
```

## 5. Let the crons take over

Once digests deliver cleanly, the scheduled crons inside the worker handle
everything. The complete current schedule is in the README's "What runs
automatically" table; `apps/worker/src/cron.ts` is the executable source of
truth.

Run `/ops` on the dashboard to see JobRun status + LLM spend + source
health at a glance.

## 6. If something goes wrong

- **No Telegram message** → see
  [TELEGRAM_SETUP.md](./TELEGRAM_SETUP.md) §3 verification.
- **Bootstrap returns 500** → tail the worker log. Most common cause is
  a missing data-source API key in `.env`.
- **Digest returns `{ok:false, reason:'throttled'}`** → the same job
  already ran within the bucket window; either it succeeded earlier or
  you need to wait out the bucket.
- **Spend alert fires on day one** → expected during cold start; bootstrap
  is the single most expensive operation. Verify on `/ops` that the
  cumulative monthly spend is still within budget.
