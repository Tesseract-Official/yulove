import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { IBucket } from 'aws-cdk-lib/aws-s3';

export type ObjectAccess = 'read' | 'write' | 'readWrite';

/**
 * Object access limited to one key pattern such as 'questions/*'. Unlike bucket.grantRead, it
 * does not hand out the bucket-wide GetBucket* and List* permissions.
 *
 * `listBucket` adds s3:ListBucket on the bucket. S3 only answers "no such key" (404) instead of
 * "access denied" (403) for a missing object when the caller can list the bucket, so reads that
 * expect a missing file need it. It lets the Lambda see key names, not read anything outside
 * the pattern.
 */
export function grantObjects(
  fn: IFunction,
  bucket: IBucket,
  access: ObjectAccess,
  pattern: string,
  options: { listBucket?: boolean } = {},
): void {
  const actions = [
    ...(access === 'write' ? [] : ['s3:GetObject']),
    ...(access === 'read' ? [] : ['s3:PutObject']),
  ];
  fn.addToRolePolicy(new PolicyStatement({ actions, resources: [bucket.arnForObjects(pattern)] }));
  if (options.listBucket) {
    fn.addToRolePolicy(
      new PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucket.bucketArn] }),
    );
  }
}
