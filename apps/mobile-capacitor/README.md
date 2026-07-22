# Vantage for iOS

This is a minimal Capacitor shell for the live Vantage deployment. It loads:

`https://vantagee.up.railway.app`

The iPhone can reach this public Railway deployment without joining Raghav's
tailnet. Codemagic builds the IPA, and Vantage's live source follows the newest
finished build automatically.

## Notifications

LiveContainer guest apps cannot receive remote push notifications. Keep this
IPA for normal use, but install the same Vantage site from Safari with Share →
Add to Home Screen for background buy, rebalance, and exceptional-opportunity
alerts. Open that Home Screen icon, then enable notifications in Vantage
Settings. The alerts are sent by Vantage and open the matching insight.

## LiveContainer source

Add the live source below once. It follows the newest finished Codemagic IPA,
the same way Atrium, OpenWhispr, and Locket do:

`https://vantagee.up.railway.app/api/v1/sidestore/source`

`apps.json` is retained only as a static emergency fallback.
