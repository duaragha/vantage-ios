import type { CapacitorConfig } from '@capacitor/cli';

const productionUrl = 'https://raghavsgamingpc.tail4d6220.ts.net:3500';

const config: CapacitorConfig = {
  appId: 'com.raghav.vantage',
  appName: 'Vantage',
  webDir: 'www',
  backgroundColor: '#090a0c',
  ios: {
    contentInset: 'never',
    preferredContentMode: 'mobile',
    allowsLinkPreview: false,
  },
  server: {
    url: process.env.CAPACITOR_SERVER_URL ?? productionUrl,
    errorPath: 'error.html',
    appendUserAgent: ' Vantage-iOS/1.0.1',
  },
};

export default config;
