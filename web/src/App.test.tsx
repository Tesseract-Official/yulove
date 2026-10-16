import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('web', () => {
  it('renders the app title', () => {
    expect(renderToString(<App />)).toContain('Paper DSA Exam Judge');
  });
});
