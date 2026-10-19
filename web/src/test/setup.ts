import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy and waitFor give up after 1 second by default, which is too short when the whole
// workspace's tests run at once on a busy machine.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no object URLs; the photo cropper makes one to show the chosen photo.
if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
}

afterEach(() => {
  // The build-script tests run in the node environment, where there is no DOM to clean up.
  if (typeof window === 'undefined') return;
  cleanup();
  window.sessionStorage.clear();
});
