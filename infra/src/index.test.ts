import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PlaceholderStack } from './index.js';

describe('infra', () => {
  it('synthesises a stack with no resources', () => {
    const template = Template.fromStack(new PlaceholderStack(new App(), 'Placeholder'));
    expect(Object.keys(template.toJSON().Resources ?? {})).toHaveLength(0);
  });
});
