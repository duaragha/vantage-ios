# Vantage for iOS

This is a minimal Capacitor shell for the live Vantage deployment. It loads:

`https://raghavsgamingpc.tail4d6220.ts.net:3000`

The iPhone must be connected to Raghav's tailnet. The IPA is built on Codemagic and distributed through the `apps.json` AltSource in this repository.

## LiveContainer source

Add the live source below once. It follows the newest finished Codemagic IPA,
the same way Atrium, OpenWhispr, and Locket do:

`https://raghavsgamingpc.tail4d6220.ts.net:3000/api/v1/sidestore/source`

`apps.json` is retained only as a static emergency fallback.
