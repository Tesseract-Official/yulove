export const PROJECT_NAME = 'paper-dsa-exam-judge';

export const ROLES = ['SUPER_ADMIN', 'TEACHER', 'BATCH_MANAGER', 'STUDENT'] as const;

export type Role = (typeof ROLES)[number];
