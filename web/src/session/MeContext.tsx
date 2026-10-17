import type { MeResponse } from '@yulove/shared';
import { createContext, useContext } from 'react';

export const MeContext = createContext<MeResponse | null>(null);

/** The signed-in user, from GET /me. Only available below SessionGate. */
export function useCurrentUser(): MeResponse {
  const me = useContext(MeContext);
  if (!me) throw new Error('useCurrentUser must be used inside SessionGate');
  return me;
}
