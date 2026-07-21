# Vantage for iOS

This is a minimal Capacitor shell for the live Vantage deployment. It loads:

`https://web-production-f6337.up.railway.app`

The iPhone can reach this public Railway deployment without joining Raghav's
tailnet. Codemagic builds the IPA, and Vantage's live source follows the newest
finished build automatically.

## LiveContainer source

Add the live source below once. It follows the newest finished Codemagic IPA,
the same way Atrium, OpenWhispr, and Locket do:

`https://web-production-f6337.up.railway.app/api/v1/sidestore/source`

`apps.json` is retained only as a static emergency fallback.
