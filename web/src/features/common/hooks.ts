import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/ApiContext.js';

/** Query keys, so a screen that changes data can refresh what another shows. */
export const keys = {
  batches: ['batches'] as const,
  staff: ['staff'] as const,
  exams: (batchId: string) => ['exams', batchId] as const,
  board: (examId: string) => ['board', examId] as const,
  answer: (examId: string, email: string, question: number) =>
    ['answer', examId, email, question] as const,
};

// These screens show their own loading and error states, so the toast stays quiet.
const meta = { errorToast: false };

export function useBatches() {
  const api = useApi();
  return useQuery({
    queryKey: keys.batches,
    queryFn: async () => (await api.listBatches()).batches,
    meta,
  });
}

export function useExams(batchId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.exams(batchId ?? ''),
    queryFn: async () => (await api.listExams(batchId ?? '')).exams,
    enabled: Boolean(batchId),
    meta,
  });
}

export function useBoard(examId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.board(examId ?? ''),
    queryFn: () => api.getBoard(examId ?? ''),
    enabled: Boolean(examId),
    meta,
  });
}
