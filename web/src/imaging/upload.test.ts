// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { PhotoUploadError, postToS3, uploadPhoto, type XhrLike } from './upload.js';

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

/** A stand-in for XMLHttpRequest that the test drives by hand. */
class FakeXhr implements XhrLike {
  upload: XhrLike['upload'] = { onprogress: null };
  status = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  opened: Array<[string, string]> = [];
  body: FormData | undefined;
  aborted = false;
  open(method: string, url: string) {
    this.opened.push([method, url]);
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number, lengthComputable = true) {
    this.upload.onprogress?.({ lengthComputable, loaded, total });
  }
  finish(status: number) {
    this.status = status;
    this.onload?.();
  }
}

describe('uploadPhoto', () => {
  it('posts the same form as postToS3 and reports progress up to done', async () => {
    const xhr = new FakeXhr();
    const seen: number[] = [];

    const sending = uploadPhoto(presigned, photo, {
      createXhr: () => xhr,
      onProgress: (f) => seen.push(f),
    });
    xhr.progress(250, 1000);
    xhr.progress(1000, 1000);
    xhr.finish(204);
    await sending;

    expect(xhr.opened).toEqual([['POST', presigned.url]]);
    const names = [...xhr.body!.entries()].map(([name]) => name);
    expect(names).toEqual([...Object.keys(presigned.fields), 'file']);
    expect(seen).toEqual([0.25, 1, 1]);
  });

  it('ignores progress that cannot be measured and never goes past 1', async () => {
    const xhr = new FakeXhr();
    const seen: number[] = [];
    const sending = uploadPhoto(presigned, photo, {
      createXhr: () => xhr,
      onProgress: (f) => seen.push(f),
    });
    xhr.progress(10, 0, false);
    xhr.progress(5000, 1000);
    xhr.finish(204);
    await sending;
    expect(seen).toEqual([1, 1]);
  });

  it('refuses a photo over the limit without sending it', async () => {
    const xhr = new FakeXhr();
    await expect(
      uploadPhoto({ ...presigned, maxBytes: 500 }, photo, { createXhr: () => xhr }),
    ).rejects.toThrow(/too large/);
    expect(xhr.body).toBeUndefined();
  });

  it('explains an expired link and a failed save in the same words as postToS3', async () => {
    for (const [status, message] of [
      [403, /link ran out/],
      [500, /error 500/],
    ] as const) {
      const xhr = new FakeXhr();
      const sending = uploadPhoto(presigned, photo, { createXhr: () => xhr });
      xhr.finish(status);
      await expect(sending).rejects.toThrow(message);
      await expect(sending).rejects.toBeInstanceOf(PhotoUploadError);
    }
  });

  it('tries once more with a plain request when the progress request gets no answer', async () => {
    const xhr = new FakeXhr();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    const seen: number[] = [];

    const sending = uploadPhoto(presigned, photo, {
      createXhr: () => xhr,
      fetchFn,
      onProgress: (f) => seen.push(f),
    });
    xhr.onerror?.();
    await sending;

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([1]);
  });

  it('says the connection is down when the plain request fails too', async () => {
    const xhr = new FakeXhr();
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('offline');
    });
    const sending = uploadPhoto(presigned, photo, { createXhr: () => xhr, fetchFn });
    xhr.ontimeout?.();
    await expect(sending).rejects.toThrow(/Check your connection/);
  });

  it('does not try again with fetch when S3 answered with an error', async () => {
    const xhr = new FakeXhr();
    const fetchFn = vi.fn<typeof fetch>();
    const sending = uploadPhoto(presigned, photo, { createXhr: () => xhr, fetchFn });
    xhr.finish(403);
    await expect(sending).rejects.toThrow(/link ran out/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('can be cancelled', async () => {
    const xhr = new FakeXhr();
    const controller = new AbortController();
    const sending = uploadPhoto(presigned, photo, {
      createXhr: () => xhr,
      signal: controller.signal,
    });
    controller.abort();
    await expect(sending).rejects.toThrow(/cancelled/);
    expect(xhr.aborted).toBe(true);
  });
});
