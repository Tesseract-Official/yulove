// Server-only: DynamoDB access, auth and audit. Do not import this from the web app.
export * from './audit.js';
export * from './auth.js';
export * from './exam-totals.js';
export * from './question-usage.js';
export * from './request-audit.js';
export * as answersDb from './db/answers.js';
export * as appealsDb from './db/appeals.js';
export * as auditLogDb from './db/audit-log.js';
export * as batchesDb from './db/batches.js';
export * as examStudentsDb from './db/exam-students.js';
export * as examsDb from './db/exams.js';
export * as questionsDb from './db/questions.js';
export * as usersDb from './db/users.js';
export { docClient, queryAll, tableName } from './db/client.js';
