import { QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useToast } from '../ui/Toaster.js';
import { createQueryClient } from './queryClient.js';

export function QueryProvider({ children }: { children: ReactNode }) {
  const { notify } = useToast();
  const [client] = useState(() => createQueryClient((message) => notify(message)));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
