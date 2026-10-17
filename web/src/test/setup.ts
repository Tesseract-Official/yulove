import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  // The build-script tests run in the node environment, where there is no DOM to clean up.
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
});
