import { describe, expect, it } from 'vitest';
import { buildApp } from '../testing.js';

const template = buildApp().templates.queues;

const EXPECTED = [
  { name: 'transcribe.fifo', visibilitySeconds: 12 * 60 },
  { name: 'execute.fifo', visibilitySeconds: 10 * 60 },
  { name: 'results.fifo', visibilitySeconds: 3 * 60 },
];

describe('QueueStack', () => {
  const queues = Object.values(template.findResources('AWS::SQS::Queue')).map(
    (r) => r.Properties as Record<string, unknown>,
  );

  it('has exactly the three queues', () => {
    template.resourceCountIs('AWS::SQS::Queue', 3);
    expect(queues.map((q) => q['QueueName']).sort()).toEqual(EXPECTED.map((q) => q.name).sort());
  });

  it.each(EXPECTED)('$name is FIFO without content-based deduplication', ({ name }) => {
    const queue = queues.find((q) => q['QueueName'] === name);
    expect(queue?.['FifoQueue']).toBe(true);
    expect(queue?.['ContentBasedDeduplication']).toBe(false);
  });

  it.each(EXPECTED)('$name has a $visibilitySeconds second visibility timeout', (expected) => {
    const queue = queues.find((q) => q['QueueName'] === expected.name);
    expect(queue?.['VisibilityTimeout']).toBe(expected.visibilitySeconds);
  });

  it('has no dead-letter queue or redrive policy', () => {
    for (const queue of queues) {
      expect(queue).not.toHaveProperty('RedrivePolicy');
    }
    expect(JSON.stringify(template.toJSON())).not.toMatch(/deadLetter|redrive/i);
  });
});
