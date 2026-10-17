/**
 * Starts a download from a link. Clicking a link works after a network request, where
 * window.open is often blocked as a pop-up. Tests replace this.
 */
export function startDownload(url: string, filename?: string): void {
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
}
