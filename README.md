# Vantage for iOS

This is a minimal Capacitor shell for the live Vantage deployment. It loads:

`https://raghavsgamingpc.tail4d6220.ts.net:3500`

The iPhone must be connected to Raghav's tailnet. Codemagic builds the IPA, and Vantage's live source follows the newest finished build automatically.

## LiveContainer source

Add the live source below once. It follows the newest finished Codemagic IPA,
the same way Atrium, OpenWhispr, and Locket do:

`https://raghavsgamingpc.tail4d6220.ts.net:3500/api/v1/sidestore/source`

`apps.json` is retained only as a static emergency fallback.
