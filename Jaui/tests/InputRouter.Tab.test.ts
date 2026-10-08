import { describe, expect, it, vi } from 'vitest';
import { InputRouter } from '../src/Core/Input/InputRouter';
import type { Platform } from '../src/Core/Platform';
import type { ScrollManager } from '../src/Scroll/Scroll.Manager';
import type { FocusManager } from '../src/Core/Focus/FocusManager';
import type { SelectionManager } from '../src/Selection/Selection.Manager';
import type { AnimationManager } from '../src/Animation/Animation.Manager';
import type { Jiv } from '../src/Jiv/Jiv';

/**
 * Drill Sentences lane AB2 follow-up (live, desktop Chrome): Tab from page load focused the
 * `<canvas>` and stayed there — never reaching a real control — which the coordinator's live check
 * could not tell apart from "something eats Tab's default action" without reading source. It doesn't:
 * `_route` below has no `'Tab'` (or default) branch that calls `preventDefault`, so the real bug was
 * never here — it was the canvas holding the only real Tab stop that existed (`Bridge.Main.ts`'s own
 * `tabIndex`, fixed separately) plus every Jwift host being unrendered `display: contents` (fixed in
 * `JivHost`, pinned in Jwift.Angular's own `JivHost.Focusable.spec.ts`). This file pins the half that
 * lives here: a `Tab` keydown reaches `InputRouter._route` and comes back out un-prevented, exactly
 * like any key this router doesn't recognize.
 */
describe('InputRouter — Tab is never one of the keys this router answers', () => {
  it('a Tab keydown falls through every branch and is never preventDefault-ed', () => {
    const focusManager = { FocusedScroller: null, SetModality: vi.fn() } as unknown as FocusManager;
    const router = new InputRouter(
      {} as Platform,
      {} as ScrollManager,
      focusManager,
      {} as SelectionManager,
      { Kick: vi.fn() } as unknown as AnimationManager,
      () => ({ Overflow: 'Visible', Children: [] }) as unknown as Jiv,
    );
    const preventDefault = vi.fn();
    const event = {
      key: 'Tab', ctrlKey: false, metaKey: false, shiftKey: false,
      defaultPrevented: false, preventDefault,
    } as unknown as KeyboardEvent;

    // `_route` is private at the type level only — TS privacy, not a runtime boundary — exactly the
    // seam this regression needs: the real question is "does Tab survive this router", and `Listen()`
    // would only add an unrelated `Platform.AddKeydownListener` wiring layer around the same call.
    (router as unknown as { _route: (e: KeyboardEvent) => void })._route(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });

  it('Shift+Tab is the same — the shift+arrow guard only matches an actual arrow key', () => {
    const focusManager = { FocusedScroller: null, SetModality: vi.fn() } as unknown as FocusManager;
    const router = new InputRouter(
      {} as Platform,
      {} as ScrollManager,
      focusManager,
      {} as SelectionManager,
      { Kick: vi.fn() } as unknown as AnimationManager,
      () => ({ Overflow: 'Visible', Children: [] }) as unknown as Jiv,
    );
    const preventDefault = vi.fn();
    const event = {
      key: 'Tab', ctrlKey: false, metaKey: false, shiftKey: true,
      defaultPrevented: false, preventDefault,
    } as unknown as KeyboardEvent;

    (router as unknown as { _route: (e: KeyboardEvent) => void })._route(event);

    expect(preventDefault).not.toHaveBeenCalled();
  });
});
