// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PhotoUploadError, postToS3 } from './upload.js';

const presigned = {
  url: 'https://bucket.s3.ap-south-1.amazonaws.com/',
  fields: {
    bucket: 'bucket',
    'Content-Type': 'image/jpeg',
    key: 'answers/exam-1/R1/q1.jpg',
    Policy: 'policy',
    'X-Amz-Signature': 'sig',
  },
  key: 'answers/exam-1/R1/q1.jpg',
  maxBytes: 5 * 1024 * 1024,
  expiresInSeconds: 600,
};
const photo = new Blob([new Uint8Array(1000)], { type: 'image/jpeg' });

describe('postToS3', () => {
  it('posts every field as given, then the photo last', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await postToS3(presigned, photo, fetchFn);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe(presigned.url);
    expect(init?.method).toBe('POST');
    const entries = [...(init?.body as FormData).entries()];
    expect(entries.map(([name]) => name)).toEqual([...Object.keys(presigned.fields), 'file']);
    for (const [name, value] of Object.entries(presigned.fields)) {
      expect(entries.find(([n]) => n === name)?.[1]).toBe(value);
    }
    const file = entries.at(-1)?.[1] as File;
    expect(file.size).toBe(1000);
    expect(file.type).toBe('image/jpeg');
  });

  it('does not send the sign-in token to S3', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));

    await postToS3(presigned, photo, fetchFn);

    expect(fetchFn.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it('refuses a photo over the limit without sending it', async () => {
    const fetchFn = vi.fn<typeof fetch>();

    await expect(postToS3({ ...presigned, maxBytes: 500 }, photo, fetchFn)).rejects.toThrow(
      /too large/,
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('explains an expired link, a failed save and a lost connection', async () => {
    const respond = (status: number) =>
      vi.fn<typeof fetch>(async () => new Response('x', { status }));

    await expect(postToS3(presigned, photo, respond(403))).rejects.toThrow(/link ran out/);
    await expect(postToS3(presigned, photo, respond(500))).rejects.toThrow(/error 500/);
    const offline = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const error = await postToS3(presigned, photo, offline).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PhotoUploadError);
    expect((error as Error).message).toMatch(/Check your connection/);
  });
});
