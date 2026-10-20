import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../api/ApiContext.js';

/** Query keys, so a screen that changes data can refresh what another shows. */
export const keys = {
  batches: ['batches'] as const,
  staff: ['staff'] as const,
  students: (batchId: string) => ['students', batchId] as const,
  exams: (batchId: string) => ['exams', batchId] as const,
  board: (examId: string) => ['board', examId] as const,
  allExams: ['exams', 'all'] as const,
  exam: (examId: string) => ['exam', examId] as const,
  questions: ['questions'] as const,
  question: (questionId: string) => ['question', questionId] as const,
  questionTests: (questionId: string) => ['question-tests', questionId] as const,
  results: (examId: string) => ['results', examId] as const,
  appeals: (examId: string) => ['appeals', examId] as const,
  audit: (examId: string, email: string, question: number) =>
    ['audit', examId, email, question] as const,
  myExams: ['my-exams'] as const,
  myExam: (examId: string) => ['my-exam', examId] as const,
  myPhoto: (examId: string, questionNumber: number) =>
    ['my-photo', examId, questionNumber] as const,
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

/** The exams of every batch the caller works with. */
export function useAllExams() {
  const api = useApi();
  return useQuery({
    queryKey: keys.allExams,
    queryFn: async () => (await api.listExams()).exams,
    meta,
  });
}

export function useExam(examId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.exam(examId ?? ''),
    queryFn: () => api.getExam(examId ?? ''),
    enabled: Boolean(examId),
    meta,
  });
}

export function useQuestions() {
  const api = useApi();
  return useQuery({
    queryKey: keys.questions,
    queryFn: async () => (await api.listQuestions()).questions,
    meta,
  });
}

export function useQuestion(questionId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.question(questionId ?? ''),
    queryFn: () => api.getQuestion(questionId ?? ''),
    enabled: Boolean(questionId),
    meta,
  });
}

export function useQuestionTests(questionId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.questionTests(questionId ?? ''),
    queryFn: () => api.getQuestionTests(questionId ?? ''),
    enabled: Boolean(questionId),
    meta,
  });
}

export function useResults(examId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.results(examId ?? ''),
    queryFn: () => api.getExamResults(examId ?? ''),
    enabled: Boolean(examId),
    meta,
  });
}

/** Every appeal of an exam, newest first (the page filters and orders them). */
export function useAppeals(examId: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.appeals(examId ?? ''),
    queryFn: async () => (await api.listAppeals(examId ?? '')).appeals,
    enabled: Boolean(examId),
    meta,
  });
}

export function useAnswer(examId: string, email: string, question: number) {
  const api = useApi();
  return useQuery({
    queryKey: keys.answer(examId, email, question),
    queryFn: () => api.getAnswer(examId, email, question),
    enabled: Boolean(examId && email && question),
    meta,
    retry: false,
  });
}
