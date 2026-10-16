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
