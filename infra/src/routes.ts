import { Duration } from 'aws-cdk-lib';
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
  options?: RouteOptions;
}

const QUESTIONS_ONLY = 'questions/*';
const EXAMS_ONLY = 'exams/*';
const ANSWERS_ONLY = 'answers/*';

/**
 * PDFKit's Node build reads `import.meta.url` when it loads, which does not exist in the CommonJS
 * bundle esbuild makes. This gives it the bundle's own file URL.
 */
export const IMPORT_META_URL_SHIM = {
  define: { 'import.meta.url': 'import_meta_url' },
  banner: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
};

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
      bucketList: true, // a missing tests.json is "not found", not "denied"
    },
  },
  {
    method: HttpMethod.POST,
    path: '/questions/{id}/approve',
    handler: 'approve-question',
    permissions: { tables: { Users: 'read', Questions: 'readWrite' } },
  },
  {
    method: HttpMethod.POST,
    path: '/exams',
    handler: 'create-exam',
    permissions: {
      tables: {
        Users: 'read',
        Batches: 'read',
        Questions: 'read',
        Exams: 'write',
        ExamStudents: 'write',
      },
    },
  },
  {
    // Reads Answers and the exam's students to find out whether the questions are locked.
    method: HttpMethod.PUT,
    path: '/exams/{id}',
    handler: 'update-exam',
    permissions: {
      tables: {
        Users: 'read',
        Batches: 'read',
        Questions: 'read',
        Exams: 'readWrite',
        ExamStudents: 'read',
        Answers: 'read',
      },
    },
  },
  {
    method: HttpMethod.POST,
    path: '/exams/{id}/pdf',
    handler: 'generate-exam-pdf',
    permissions: {
      tables: { Users: 'read', Batches: 'read', Questions: 'read', Exams: 'readWrite' },
      bucket: 'write', // PutObject, only under exams/
      bucketPrefix: EXAMS_ONLY,
    },
    options: {
      memorySize: 512,
      timeout: Duration.seconds(29), // API Gateway gives up at 30
      // The PDF uses these fonts; they sit next to the bundled handler.
      assets: [{ from: 'services/api/assets/fonts', to: 'fonts' }],
      bundling: IMPORT_META_URL_SHIM,
    },
  },
  {
    method: HttpMethod.GET,
    path: '/exams/{id}/pdf',
    handler: 'get-exam-pdf',
    permissions: {
      tables: { Users: 'read', Exams: 'read' },
      bucket: 'read', // GetObject, only under exams/: the download link is signed with it
      bucketPrefix: EXAMS_ONLY,
    },
  },
  {
    method: HttpMethod.POST,
    path: '/answers/upload-url',
    handler: 'request-upload-url',
    permissions: {
      // Reads who the student is and whether the exam takes answers; creates the student's
      // ExamStudents row if they were imported after the exam was made.
      tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite' },
      // The signed upload is made with this role, so the role may put objects under answers/.
      bucket: 'write',
      bucketPrefix: ANSWERS_ONLY,
    },
  },
  {
    method: HttpMethod.POST,
    path: '/answers/submit',
    handler: 'submit-answer',
    permissions: {
      tables: { Users: 'read', Exams: 'read', ExamStudents: 'readWrite', Answers: 'write' },
      // HeadObject on the photo; the listing right makes a missing photo a 404, not a 403.
      bucket: 'read',
      bucketPrefix: ANSWERS_ONLY,
      bucketList: true,
      queues: { transcribe: 'send' },
    },
  },
];

/** Registers every API route on the stack. */
export function registerRoutes(api: ApiStack, config: { collegeDomain: string }): void {
  for (const route of ROUTES) {
    const options: RouteOptions = {
      ...route.options,
      ...(route.needsCollegeDomain
        ? { environment: { COLLEGE_DOMAIN: config.collegeDomain } }
        : {}),
    };
    api.addRoute(
      route.method,
      route.path,
      serviceEntry(`api/src/handlers/${route.handler}.ts`),
      route.permissions,
      options,
    );
  }
}
