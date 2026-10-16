import { HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { serviceEntry } from './lib/handler-paths.js';
import type { ApiStack, RouteOptions, RoutePermissions } from './stacks/api-stack.js';

interface RouteDef {
  method: HttpMethod;
  path: string;
  /** Handler file under services/api/src/handlers. */
  handler: string;
  /** Least privilege: only what the handler touches. Every handler also reads Users (requireUser). */
  permissions: RoutePermissions;
  /** Needs the college domain to validate emails. */
  needsCollegeDomain?: boolean;
}

const QUESTIONS_ONLY = 'questions/*';

export const ROUTES: readonly RouteDef[] = [
  {
    method: HttpMethod.GET,
    path: '/me',
    handler: 'get-me',
    permissions: { tables: { Users: 'read', Batches: 'read' } },
  },
  {
    method: HttpMethod.POST,
    path: '/staff',
    handler: 'create-staff',
    permissions: { tables: { Users: 'readWrite', Batches: 'read' } },
    needsCollegeDomain: true,
  },
  {
    method: HttpMethod.PUT,
    path: '/staff/{email}/batches',
    handler: 'assign-batches',
    permissions: { tables: { Users: 'readWrite', Batches: 'read' } },
  },
  {
    method: HttpMethod.POST,
    path: '/batches',
    handler: 'create-batch',
    permissions: { tables: { Users: 'read', Batches: 'write' } },
  },
  {
    method: HttpMethod.POST,
    path: '/batches/{batchId}/students/import',
    handler: 'import-students',
    permissions: { tables: { Users: 'readWrite', Batches: 'read' } },
    needsCollegeDomain: true,
  },
  {
    method: HttpMethod.GET,
    path: '/batches/{batchId}/students',
    handler: 'list-students',
    permissions: { tables: { Users: 'read', Batches: 'read' } },
  },
  {
    method: HttpMethod.POST,
    path: '/questions',
    handler: 'create-question',
    permissions: { tables: { Users: 'read', Questions: 'write' } },
  },
  {
    // Reads Exams and Answers to find out whether the version is already in use.
    method: HttpMethod.PUT,
    path: '/questions/{id}',
    handler: 'update-question',
    permissions: {
      tables: { Users: 'read', Questions: 'readWrite', Exams: 'read', Answers: 'read' },
    },
  },
  {
    method: HttpMethod.POST,
    path: '/questions/{id}/generate-tests',
    handler: 'start-test-generation',
    permissions: {
      tables: { Users: 'read', Questions: 'readWrite', Exams: 'read', Answers: 'read' },
      lambdas: { testGeneration: 'invoke' },
    },
  },
  {
    method: HttpMethod.GET,
    path: '/questions/{id}/tests',
    handler: 'get-question-tests',
    permissions: {
      tables: { Users: 'read', Questions: 'read' },
      bucket: 'read',
      bucketPrefix: QUESTIONS_ONLY,
    },
  },
  {
    method: HttpMethod.POST,
    path: '/questions/{id}/approve',
    handler: 'approve-question',
    permissions: { tables: { Users: 'read', Questions: 'readWrite' } },
  },
];

/** Registers every API route on the stack. */
export function registerRoutes(api: ApiStack, config: { collegeDomain: string }): void {
  for (const route of ROUTES) {
    const options: RouteOptions = route.needsCollegeDomain
      ? { environment: { COLLEGE_DOMAIN: config.collegeDomain } }
      : {};
    api.addRoute(
      route.method,
      route.path,
      serviceEntry(`api/src/handlers/${route.handler}.ts`),
      route.permissions,
      options,
    );
  }
}
