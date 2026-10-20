import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wholeBox } from '../../imaging/cropMath.js';
import { PhotoAdjuster, type Edit } from './PhotoAdjuster.js';
import type { WorkingPhoto } from './useWorkingPhoto.js';

/**
 * The adjust screen, driven the way a finger would: pointer events on the stage. jsdom has no
 * layout, so the stage is given a fixed 400 x 600 size. With a 3200 x 2400 photo that makes one
 * screen pixel 1 / 0.11 = 9.09 photo pixels at "fit", and the photo sits at x 24..376, y 168..432.
 */
const photo: WorkingPhoto = {
  blob: new Blob(['photo']),
  url: 'blob:test',
  width: 3200,
  height: 2400,
  suggestedBox: wholeBox({ width: 3200, height: 2400 }),
  detected: false,
};
const FIT = (400 - 48) / 3200; // screen pixels per photo pixel at fit

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 400,
    bottom: 600,
    width: 400,
    height: 600,
    toJSON: () => ({}),
  });
});
afterEach(() => vi.restoreAllMocks());

function setup(initial: Partial<Edit> = {}) {
  const edits: Edit[] = [];
  const callbacks = { onRetake: vi.fn(), onNext: vi.fn() };
  function Host() {
    const [edit, setEdit] = useState<Edit>({
      rotation: 0,
      box: photo.suggestedBox,
      ...initial,
    });
    return (
      <PhotoAdjuster
        photo={photo}
        edit={edit}
        onEdit={(next) => {
          edits.push(next);
          setEdit(next);
        }}
        {...callbacks}
      />
    );
  }
  render(<Host />);
  const stage = screen.getByTestId('adjuster-stage');
  const pointer = (type: string, id: number, x: number, y: number) =>
    fireEvent(
      stage,
      Object.assign(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }), {
        pointerId: id,
      }),
    );
  const box = () => {
    const el = screen.getByTestId('crop-box');
    return {
      x: Number(el.dataset['x']),
      y: Number(el.dataset['y']),
      width: Number(el.dataset['width']),
      height: Number(el.dataset['height']),
    };
  };
  const photoLeft = () =>
    Number.parseFloat((document.querySelector('.adjuster-photo') as HTMLElement).style.left);
  return { edits, callbacks, stage, pointer, box, photoLeft };
}

const zoomLabel = () => document.querySelector('.adjuster-zoom')?.textContent;

describe('the crop box', () => {
  it('starts where it is told to, with a handle on every corner and edge', () => {
    setup({ box: { x: 400, y: 300, width: 1600, height: 1200 } });
    const crop = screen.getByTestId('crop-box');
    expect([
      crop.dataset['x'],
      crop.dataset['y'],
      crop.dataset['width'],
      crop.dataset['height'],
    ]).toEqual(['400', '300', '1600', '1200']);
    expect(document.querySelectorAll('.adjuster-handle')).toHaveLength(8);
  });

  it('is resized freely by dragging a corner: both sides move, with no fixed shape', () => {
    const { pointer, box } = setup();
    // The top-left corner of the whole-photo box is at screen (24, 168).
    pointer('pointerdown', 1, 26, 170);
    pointer('pointermove', 1, 76, 230);
    pointer('pointerup', 1, 76, 230);

    const b = box();
    expect(b.x).toBeCloseTo(50 / FIT, -1);
    expect(b.y).toBeCloseTo(60 / FIT, -1);
    expect(b.width).toBeCloseTo(3200 - 50 / FIT, -1);
    expect(b.height).toBeCloseTo(2400 - 60 / FIT, -1);
    // Not the A4 shape or any other fixed one.
    expect(b.width / b.height).not.toBeCloseTo(210 / 297, 1);
  });

  it('is resized along one side by dragging an edge', () => {
    const { pointer, box } = setup();
    // The right edge, halfway down: screen (376, 300).
    pointer('pointerdown', 1, 374, 300);
    pointer('pointermove', 1, 324, 300);
    pointer('pointerup', 1, 324, 300);

    const b = box();
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.height).toBe(2400);
    expect(b.width).toBeCloseTo(3200 - 50 / FIT, -1);
  });

  it('never leaves the photo or gets tiny, however far it is dragged', () => {
    const { pointer, box } = setup();
    pointer('pointerdown', 1, 26, 170);
    pointer('pointermove', 1, -500, -500);
    expect(box()).toEqual({ x: 0, y: 0, width: 3200, height: 2400 });
    pointer('pointermove', 1, 5000, 5000);
    const b = box();
    expect(b.width).toBeGreaterThanOrEqual(120); // 5% of the shorter side
    expect(b.height).toBeGreaterThanOrEqual(120);
    expect(b.x + b.width).toBeLessThanOrEqual(3200);
  });

  it('goes back to the whole photo with one tap', async () => {
    const { box } = setup({ box: { x: 400, y: 300, width: 1600, height: 1200 } });
    await userEvent.click(screen.getByRole('button', { name: 'Whole photo' }));
    expect(box()).toEqual({ x: 0, y: 0, width: 3200, height: 2400 });
  });
});

describe('turning the photo', () => {
  it('turns the crop box with it, so it keeps covering the same part of the page', async () => {
    const { box, edits } = setup({ box: { x: 400, y: 300, width: 1600, height: 1200 } });

    await userEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    // (x, y) in a 3200 x 2400 photo goes to (2400 - y - h, x) in the 2400 x 3200 turned one.
    expect(box()).toEqual({ x: 900, y: 400, width: 1200, height: 1600 });
    expect(edits.at(-1)?.rotation).toBe(90);

    await userEvent.click(screen.getByRole('button', { name: 'Rotate left' }));
    expect(box()).toEqual({ x: 400, y: 300, width: 1600, height: 1200 });
    expect(edits.at(-1)?.rotation).toBe(0);
  });

  it('goes round: left from upright is 270, and four turns are none', async () => {
    const { edits } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Rotate left' }));
    expect(edits.at(-1)?.rotation).toBe(270);
    for (let i = 0; i < 4; i += 1) {
      await userEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    }
    expect(edits.at(-1)?.rotation).toBe(270);
  });

  it('shows the photo turned', async () => {
    setup();
    const image = screen.getByAltText('The photo to send');
    expect(image.style.transform).toContain('rotate(0deg)');
    await userEvent.click(screen.getByRole('button', { name: 'Rotate right' }));
    expect(screen.getByAltText('The photo to send').style.transform).toContain('rotate(90deg)');
  });
});

describe('zooming and moving the photo', () => {
  it('zooms with the + and - buttons, and Fit comes back', async () => {
    setup();
    expect(zoomLabel()).toBe('100%');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomLabel()).toBe('150%');
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(zoomLabel()).toBe('225%');
    expect(screen.getByRole('button', { name: 'Zoom out' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(zoomLabel()).toBe('150%');

    await userEvent.click(screen.getByRole('button', { name: 'Fit' }));
    expect(zoomLabel()).toBe('100%');
  });

  it('stops at the largest zoom', async () => {
    setup();
    const zoomIn = screen.getByRole('button', { name: 'Zoom in' });
    for (let i = 0; i < 12; i += 1) await userEvent.click(zoomIn);
    expect(zoomLabel()).toBe('800%');
    expect(zoomIn).toBeDisabled();
  });

  it('zooms with two fingers moving apart, about the point between them', () => {
    const { pointer } = setup();
    pointer('pointerdown', 1, 150, 300);
    pointer('pointerdown', 2, 250, 300);
    pointer('pointermove', 2, 350, 300); // 100 px apart became 200
    expect(zoomLabel()).toBe('200%');
    pointer('pointermove', 2, 250, 300); // and back
    expect(zoomLabel()).toBe('100%');
  });

  it('does not resize the crop box while pinching, even from a handle', () => {
    const { pointer, box } = setup();
    pointer('pointerdown', 1, 26, 170); // on the corner handle
    pointer('pointerdown', 2, 300, 400); // a second finger turns it into a pinch
    pointer('pointermove', 2, 380, 450);
    expect(box()).toEqual({ x: 0, y: 0, width: 3200, height: 2400 });
  });

  it('moves a zoomed photo with one finger, and the crop box stays with the photo', async () => {
    const { pointer, photoLeft, box } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    const before = photoLeft();

    // Start away from the box edges (the middle of the photo) and drag left.
    pointer('pointerdown', 1, 200, 300);
    pointer('pointermove', 1, 150, 300);
    pointer('pointerup', 1, 150, 300);

    expect(photoLeft()).toBeCloseTo(before - 50, 3);
    expect(box()).toEqual({ x: 0, y: 0, width: 3200, height: 2400 }); // dragging the photo is not cropping
  });

  it('keeps a photo that fits in place when it is dragged', () => {
    const { pointer, photoLeft } = setup();
    const before = photoLeft();
    pointer('pointerdown', 1, 200, 300);
    pointer('pointermove', 1, 100, 300);
    expect(photoLeft()).toBe(before);
  });

  it('carries on as a drag when one finger of a pinch is lifted', async () => {
    const { pointer, photoLeft } = setup();
    pointer('pointerdown', 1, 150, 300);
    pointer('pointerdown', 2, 250, 300);
    pointer('pointermove', 2, 350, 300);
    pointer('pointerup', 2, 350, 300);
    const before = photoLeft();
    pointer('pointermove', 1, 130, 300);
    expect(photoLeft()).toBeCloseTo(before - 20, 3);
  });

  it('zooms with the mouse wheel', () => {
    const { stage } = setup();
    fireEvent.wheel(stage, { deltaY: -100, clientX: 200, clientY: 300 });
    expect(zoomLabel()).toBe('115%');
    fireEvent.wheel(stage, { deltaY: 100, clientX: 200, clientY: 300 });
    expect(zoomLabel()).toBe('100%');
  });

  it('stops the iPhone from zooming the whole page when the photo is pinched', () => {
    const { stage } = setup();
    const event = new Event('gesturestart', { bubbles: true, cancelable: true });
    stage.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('the controls', () => {
  it('has big controls for one-handed use, all reachable by name', () => {
    setup();
    for (const name of [
      'Rotate left',
      'Rotate right',
      'Zoom out',
      'Zoom in',
      'Fit',
      'Whole photo',
      'Retake',
      'Next',
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('calls back for Retake and Next', async () => {
    const { callbacks } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Retake' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(callbacks.onRetake).toHaveBeenCalledTimes(1);
    expect(callbacks.onNext).toHaveBeenCalledTimes(1);
  });
});
