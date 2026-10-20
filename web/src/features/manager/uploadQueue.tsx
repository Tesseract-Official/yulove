import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import { useApi } from '../../api/ApiContext.js';
import { errorMessage } from '../../api/errors.js';
import { uploadPhoto } from '../../imaging/upload.js';
import { keys } from '../common/hooks.js';
import type { QueueStatus } from './nextTarget.js';

/** How many photos go up at the same time: enough to keep a phone busy, not enough to starve it. */
export const UPLOAD_CONCURRENCY = 2;

export interface QueueItem {
  id: string;
  examId: string;
  studentEmail: string;
  /** "R1 · Asha Rao", for messages. */
  studentLabel: string;
  question: number;
  /** Bytes of the photo. */
  size: number;
  status: QueueStatus;
  /** How much of the photo has gone up, 0 to 1. */
  progress: number;
  /** Why the last try failed. */
  error?: string;
  /** How many times it has been tried. */
  attempts: number;
}

export interface EnqueueInput {
  examId: string;
  studentEmail: string;
  studentLabel: string;
  question: number;
  photo: Blob;
}

export interface UploadQueue {
  items: readonly QueueItem[];
  /** Adds a photo to send. False when the same question's photo is going up right now. */
  enqueue(input: EnqueueInput): boolean;
  retry(id: string): void;
  retryAll(): void;
  /** Gives up on a photo that failed. Only ever on request: nothing is dropped silently. */
  discard(id: string): void;
  /** What this device knows about one question's photo. */
  statusOf(examId: string, studentEmail: string, question: number): QueueStatus | undefined;
  /** The item for one question, if any. */
  itemFor(examId: string, studentEmail: string, question: number): QueueItem | undefined;
  /** Photos not safely at the server yet: waiting, going up, or failed. */
  unsent: number;
  failed: number;
}

type Action =
  | { type: 'add'; item: QueueItem }
  | { type: 'start'; id: string }
  | { type: 'progress'; id: string; progress: number }
  | { type: 'done'; id: string }
  | { type: 'fail'; id: string; error: string }
  | { type: 'requeue'; ids: string[] }
  | { type: 'remove'; id: string };

const sameQuestion = (a: QueueItem, b: Pick<QueueItem, 'examId' | 'studentEmail' | 'question'>) =>
  a.examId === b.examId && a.studentEmail === b.studentEmail && a.question === b.question;

function reducer(items: QueueItem[], action: Action): QueueItem[] {
  const change = (id: string, patch: (item: QueueItem) => QueueItem) =>
    items.map((item) => (item.id === id ? patch(item) : item));
  switch (action.type) {
    case 'add':
      // A new photo for a question replaces what was there before (a failed one, or an old send).
      return [...items.filter((i) => !sameQuestion(i, action.item)), action.item];
    case 'start':
      return change(action.id, (i) => ({
        ...i,
        status: 'sending',
        progress: 0,
        attempts: i.attempts + 1,
        error: undefined,
      }));
    case 'progress':
      return change(action.id, (i) =>
        i.status === 'sending' ? { ...i, progress: action.progress } : i,
      );
    case 'done':
      return change(action.id, (i) => ({ ...i, status: 'done', progress: 1 }));
    case 'fail':
      return change(action.id, (i) => ({ ...i, status: 'failed', error: action.error }));
    case 'requeue':
      return items.map((i) =>
        action.ids.includes(i.id) && i.status === 'failed'
          ? { ...i, status: 'queued', progress: 0, error: undefined }
          : i,
      );
    case 'remove':
      return items.filter((i) => i.id !== action.id);
  }
}

const UploadQueueContext = createContext<UploadQueue | null>(null);

export function useUploadQueue(): UploadQueue {
  const value = useContext(UploadQueueContext);
  if (!value) throw new Error('useUploadQueue must be used inside UploadQueueProvider');
  return value;
}

let counter = 0;
const newId = () => `photo-${(counter += 1)}`;

/**
 * Holds the photos a batch manager has taken until the server has them. It lives above the pages,
 * so photos keep going up while the manager moves around the app, and a photo is only ever removed
 * once it is sent or the manager discards it. While any photo is not sent, closing or reloading the
 * tab asks first.
 */
export function UploadQueueProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [items, dispatch] = useReducer(reducer, [] as QueueItem[]);
  // The latest items, for functions that must not change identity on every update.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  /** The photos themselves, kept out of React state; removed once sent. */
  const photos = useRef(new Map<string, Blob>());
  /** Items whose upload has been started, so none is started twice. */
  const started = useRef(new Set<string>());

  const run = useCallback(
    async (item: QueueItem) => {
      const photo = photos.current.get(item.id);
      if (!photo) {
        dispatch({
          type: 'fail',
          id: item.id,
          error: 'This photo is no longer on the device. Take it again.',
        });
        return;
      }
      let lastPercent = -1;
      try {
        const body = {
          examId: item.examId,
          studentEmail: item.studentEmail,
          questionNumber: item.question,
        };
        // A fresh upload link every time: a link only lasts ten minutes and a retry may be later.
        const presigned = await api.requestUploadUrl({ ...body, contentType: 'image/jpeg' });
        await uploadPhoto(presigned, photo, {
          onProgress: (fraction) => {
            const percent = Math.round(fraction * 100);
            if (percent === lastPercent) return;
            lastPercent = percent;
            dispatch({ type: 'progress', id: item.id, progress: fraction });
          },
        });
        await api.submitAnswer(body);
        photos.current.delete(item.id);
        dispatch({ type: 'done', id: item.id });
      } catch (error) {
        dispatch({ type: 'fail', id: item.id, error: errorMessage(error) });
      } finally {
        started.current.delete(item.id);
        // The student may have been marked absent meanwhile, or the answer may now be queued.
        void queryClient.invalidateQueries({ queryKey: keys.board(item.examId) });
      }
    },
    [api, queryClient],
  );

  // Start waiting photos while there is room.
  useEffect(() => {
    const going = items.filter((i) => i.status === 'sending').length;
    let room = UPLOAD_CONCURRENCY - going;
    for (const item of items) {
      if (room <= 0) break;
      if (item.status !== 'queued' || started.current.has(item.id)) continue;
      started.current.add(item.id);
      room -= 1;
      dispatch({ type: 'start', id: item.id });
      void run(item);
    }
  }, [items, run]);

  const unsent = items.filter((i) => i.status !== 'done').length;
  const failed = items.filter((i) => i.status === 'failed').length;

  // Closing or reloading the tab with photos not sent would lose them: ask first.
  useEffect(() => {
    if (unsent === 0) return undefined;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Some browsers still need a value here to show the question.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsent]);

  const enqueue = useCallback((input: EnqueueInput): boolean => {
    const before = itemsRef.current.filter((i) => sameQuestion(i, input));
    // The same question's photo is going up right now: let it finish first.
    if (before.some((i) => started.current.has(i.id))) return false;
    for (const old of before) photos.current.delete(old.id);
    const id = newId();
    photos.current.set(id, input.photo);
    dispatch({
      type: 'add',
      item: {
        id,
        examId: input.examId,
        studentEmail: input.studentEmail,
        studentLabel: input.studentLabel,
        question: input.question,
        size: input.photo.size,
        status: 'queued',
        progress: 0,
        attempts: 0,
      },
    });
    return true;
  }, []);

  const value = useMemo<UploadQueue>(
    () => ({
      items,
      enqueue,
      retry: (id) => dispatch({ type: 'requeue', ids: [id] }),
      retryAll: () =>
        dispatch({
          type: 'requeue',
          ids: items.filter((i) => i.status === 'failed').map((i) => i.id),
        }),
      discard: (id) => {
        const item = items.find((i) => i.id === id);
        if (!item || item.status === 'sending') return;
        photos.current.delete(id);
        dispatch({ type: 'remove', id });
      },
      statusOf: (examId, studentEmail, question) =>
        items.find((i) => sameQuestion(i, { examId, studentEmail, question }))?.status,
      itemFor: (examId, studentEmail, question) =>
        items.find((i) => sameQuestion(i, { examId, studentEmail, question })),
      unsent,
      failed,
    }),
    [items, enqueue, unsent, failed],
  );

  return <UploadQueueContext.Provider value={value}>{children}</UploadQueueContext.Provider>;
}
