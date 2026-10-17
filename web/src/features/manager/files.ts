/** The text of a file the person chose. Falls back to FileReader where Blob.text is missing. */
export function readFileText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('The file could not be read. Choose it again.'));
    reader.readAsText(file);
  });
}
