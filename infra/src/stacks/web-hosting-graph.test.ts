import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const dependencyNames = (stack: { dependencies: { node: { id: string } }[] }) =>
  stack.dependencies.map((dependency) => dependency.node.id);

describe('stack dependencies for the web app', () => {
  const built = buildApp(undefined, { routes: true, webDeploy: true, worker: false });

  it('synthesises: a circular reference between stacks would throw here', () => {
    expect(() => built.app.synth()).not.toThrow();
  });

  it('WebHosting depends on no other stack', () => {
    expect(built.hosting.dependencies).toEqual([]);
  });

  it('Data, Auth and Api take the CloudFront URL from WebHosting', () => {
    for (const stack of [built.data, built.auth, built.api]) {
      expect(dependencyNames(stack), stack.node.id).toContain('WebHosting');
    }
  });

  it('WebHosting is not reached back from Auth or Api (no reference points into WebDeploy)', () => {
    for (const stack of [built.hosting, built.auth, built.api, built.data]) {
      expect(dependencyNames(stack), stack.node.id).not.toContain('WebDeploy');
    }
  });

  it('WebDeploy depends on WebHosting, Auth and Api', () => {
    const names = dependencyNames(built.webDeploy!);
    expect(names).toEqual(expect.arrayContaining(['WebHosting', 'Auth', 'Api']));
  });
});
