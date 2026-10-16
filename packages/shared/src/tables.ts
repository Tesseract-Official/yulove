/** Table, queue and env var names. Mirrors infra's DataStack, QueueStack and ApiStack.addRoute. */
export const TABLE_NAMES = [
  'Users',
  'Batches',
  'Questions',
  'Exams',
  'ExamStudents',
  'Answers',
  'Appeals',
  'AuditLog',
] as const;
export type TableName = (typeof TABLE_NAMES)[number];

/** Env var that addRoute sets to each table's name. */
export const TABLE_ENV: Record<TableName, string> = {
  Users: 'USERS_TABLE',
  Batches: 'BATCHES_TABLE',
  Questions: 'QUESTIONS_TABLE',
  Exams: 'EXAMS_TABLE',
  ExamStudents: 'EXAM_STUDENTS_TABLE',
  Answers: 'ANSWERS_TABLE',
  Appeals: 'APPEALS_TABLE',
  AuditLog: 'AUDIT_LOG_TABLE',
};

export const QUEUE_NAMES = ['transcribe', 'execute', 'results'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Env var that addRoute sets to each queue's URL. */
export const QUEUE_ENV: Record<QueueName, string> = {
  transcribe: 'TRANSCRIBE_QUEUE_URL',
  execute: 'EXECUTE_QUEUE_URL',
  results: 'RESULTS_QUEUE_URL',
};

export const BUCKET_ENV = 'BUCKET_NAME';
