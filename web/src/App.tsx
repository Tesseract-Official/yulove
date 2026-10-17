import type { ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { ApiProvider } from './api/ApiContext.js';
import { AuthProvider } from './auth/AuthContext.js';
import type { OidcClient } from './auth/userManager.js';
import type { AppConfig } from './config/config.js';
import { ConfigProvider } from './config/ConfigContext.js';
import { QueryProvider } from './query/QueryProvider.js';
import { AppRoutes } from './routes.js';
import { ToastProvider } from './ui/Toaster.js';

export interface AppProvidersProps {
  config: AppConfig;
  children: ReactNode;
  /** Tests supply a fake sign-in client. */
  authClient?: OidcClient;
  navigateExternal?: (url: string) => void;
}

/** Everything the screens need except the router: config, toasts, sign-in, API and query cache. */
export function AppProviders({
  config,
  children,
  authClient,
  navigateExternal,
}: AppProvidersProps) {
  return (
    <ConfigProvider config={config}>
      <ToastProvider>
        <AuthProvider
          {...(authClient ? { client: authClient } : {})}
          {...(navigateExternal ? { navigateExternal } : {})}
        >
          <ApiProvider>
            <QueryProvider>{children}</QueryProvider>
          </ApiProvider>
        </AuthProvider>
      </ToastProvider>
    </ConfigProvider>
  );
}

export function App({ config }: { config: AppConfig }) {
  return (
    <AppProviders config={config}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProviders>
  );
}
