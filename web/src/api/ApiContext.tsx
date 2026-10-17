import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext.js';
import { useConfig } from '../config/ConfigContext.js';
import { createApiClient } from './client.js';
import { createEndpoints, type Endpoints } from './endpoints.js';

const ApiContext = createContext<Endpoints | null>(null);

/** Builds the API client from the config and the signed-in user's ID token. */
export function ApiProvider({ children }: { children: ReactNode }) {
  const { apiUrl } = useConfig();
  const { getIdToken, signIn } = useAuth();

  const endpoints = useMemo(
    () =>
      createEndpoints(
        createApiClient({
          baseUrl: apiUrl,
          getIdToken,
          // The session is over (the ID token could not be renewed): start again from this page.
          onUnauthorized: () => {
            void signIn(`${window.location.pathname}${window.location.search}`);
          },
        }),
      ),
    [apiUrl, getIdToken, signIn],
  );
  return <ApiContext.Provider value={endpoints}>{children}</ApiContext.Provider>;
}

export function useApi(): Endpoints {
  const value = useContext(ApiContext);
  if (!value) throw new Error('useApi must be used inside ApiProvider');
  return value;
}
