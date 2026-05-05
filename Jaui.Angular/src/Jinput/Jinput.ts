import {
  ChangeDetectionStrategy, Component, ElementRef, OnDestroy,
  computed, effect, inject, input, model, output, signal, viewChild,
} from '@angular/core';
import { Jaui } from '../Jaui/Jaui';
import { Jiv } from '../Jiv/Jiv';
import { Jext } from '../Jext/Jext';
import { Jyle } from '../Jyle/Jyle';
import {
  LayoutSegments, CharPosition, IndexAtPoint, RangeRects, WordRangeAt,
  type LayoutMetrics, type LayoutSegmentInput, type LaidOutSegment,
} from './Jinput.Layout';
import JinputJss from './Jinput.jss';

/**
 * `<jinput>` — canvas-rendered editable text primitive.
 *
 * Pure mechanics: focus, caret blink, selection (drag-extend, click-burst,
 * shift-arrow), wrap-aware layout, click-to-position, native keyboard +
 * clipboard. Sits next to `<jiv>` and `<jext>` as a foundational primitive.
 *
 * Single-line vs multi-line is a sizing config, not a different component.
 * Constrain Height to one line for single-line; use min-content / unbounded
 * for auto-grow. Wrap follows the wrap container's Width.
 *
 * Per-range styling via the `Spans` input. Each span provides Color /
 * Background overrides for a `[Start, End)` range. Spans don't overlap
 * (caller normalizes). Empty spans = whole text rendered with default
 * style. The PositionClicked event lets consumers layer click semantics
 * (e.g. "click on a token opens its config") on top — calling
 * `event.preventDefault()` skips the default caret-positioning.
 *
 * Input capture uses a hidden offscreen native `<input>`; clicks on the
 * canvas focus it so keystrokes route through native edit semantics.
 * Caret + selection are drawn into the canvas tree as `Position:Placed`
 * Jiv overlays inside the wrap. Pixel positions come from canvas
 * `measureText` against the same font config the renderer uses.
 */

export interface JinputSpan {
  Start: number;
  End: number;
  Color?: string;
  Background?: string;
}

interface RenderedSegment extends LayoutSegmentInput {
  Color?: string;
  Background?: string;
}

@Component({
  selector: 'jinput',
  standalone: true,
  imports: [Jiv, Jext, Jyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <jyle [source]="JssSource" />

    <jiv class="JinputRoot"
      (pointerdown)="onRootPointerDown($event)"
      (contextmenu)="onRootContextMenu($event)">
      <jiv #wrap class="JinputWrap">
        @if (showPlaceholder()) {
          <jext class="JinputPlaceholder" [text]="Placeholder()" />
        } @else {
          <!-- Selection rects FIRST so segment text paints on top. -->
          @for (rect of SelectionRects(); track $index) {
            <jiv
              class="JinputSelectionRect"
              [childLayout]="{
                Position: 'Placed',
                Left: rect.x + 'px',
                Top: rect.y + 'px',
                Width: rect.width + 'px',
                Height: rect.height + 'px',
              }" />
          }
          @for (segment of RenderedSegments(); track $index) {
            <jext
              class="JinputSegment"
              [text]="segment.Text"
              [textStyle]="segmentTextStyle(segment)" />
          }
          @if (CaretRect(); as cr) {
            <jiv
              class="JinputCaret"
              [childLayout]="{
                Position: 'Placed',
                Left: cr.x + 'px',
                Top: cr.y + 'px',
                Width: '2px',
                Height: cr.height + 'px',
              }" />
          }
        }
      </jiv>
    </jiv>

    <input
      #hiddenInput
      type="text"
      class="HiddenInput"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      [readOnly]="ReadOnly()"
      (input)="onInput($event)"
      (focus)="onFocus()"
      (blur)="onBlur()"
      (keydown)="onKeyDown($event)"
      (keyup)="syncSelection()"
      (click)="syncSelection()" />
  `,
  styles: [`
    :host { display: contents; }
    .HiddenInput {
      position: fixed;
      top: -9999px;
      left: -9999px;
      width: 1px;
      height: 1px;
      opacity: 0;
      border: 0;
      padding: 0;
      margin: 0;
      pointer-events: none;
    }
  `],
})
export class Jinput implements OnDestroy {
  readonly JssSource = JinputJss;

  // ── Inputs ──────────────────────────────────────────────────────
  readonly Text = model('');
  readonly Spans = input<readonly JinputSpan[]>([]);
  readonly Placeholder = input('');
  readonly ReadOnly = input(false);

  /** Font config used both for canvas measureText (layout) and JSS-driven
   *  rendering. Defaults to system-ui at 20px (16pt × 1.25 default scale).
   *  Wrappers (Jwift's TextInput, app-level styles) override these. */
  readonly FontFamily = input('system-ui, sans-serif');
  readonly FontSizePx = input(20);
  readonly FontWeight = input(400);
  readonly LineHeightRatio = input(1.6);
  readonly RowGapPx = input(5);

  // ── Outputs ─────────────────────────────────────────────────────
  /** Char-index click. Fires before caret positioning; consumers can call
   *  event.preventDefault() to skip the default caret move. */
  readonly PositionClicked = output<{ index: number; event: PointerEvent }>();
  /** Char-index hover. Index is null when hover leaves the text region. */
  readonly PositionHovered = output<{ index: number | null }>();
  readonly FocusChanged = output<boolean>();
  /** Right-click. Consumer can preventDefault and open their own menu;
   *  otherwise the browser native menu fires on the offscreen input. */
  readonly ContextMenuRequested = output<{
    event: MouseEvent;
    selStart: number;
    selEnd: number;
    value: string;
  }>();

  // ── Refs ────────────────────────────────────────────────────────
  private readonly _jaui = inject(Jaui, { optional: true });
  private readonly _hiddenInput = viewChild<ElementRef<HTMLInputElement>>('hiddenInput');
  private readonly _wrap = viewChild<Jiv>('wrap');

  // ── Internal state ──────────────────────────────────────────────
  private readonly _selStart = signal(0);
  private readonly _selEnd = signal(0);
  private readonly _focused = signal(false);
  private readonly _caretBright = signal(true);
  private _blinkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _wrapWidth = signal(600);

  // ── Computed: derived metrics, segments, layout ─────────────────
  readonly showPlaceholder = computed(() =>
    this.Text().length === 0 && this.Placeholder().length > 0,
  );

  /** Splits Text by Spans into rendering segments, each with its [Start,
   *  End) range and optional Color / Background overrides. Empty Spans →
   *  one segment for the whole text. Spans must not overlap. */
  readonly RenderedSegments = computed<RenderedSegment[]>(() => {
    const text = this.Text();
    const spans = this.Spans();
    if (spans.length === 0) {
      return text.length === 0
        ? []
        : [{ Text: text, StartIndex: 0, EndIndex: text.length }];
    }
    const sorted = [...spans].sort((a, b) => a.Start - b.Start);
    const out: RenderedSegment[] = [];
    let cursor = 0;
    for (const span of sorted) {
      if (span.Start > cursor) {
        out.push({
          Text: text.slice(cursor, span.Start),
          StartIndex: cursor,
          EndIndex: span.Start,
        });
      }
      out.push({
        Text: text.slice(span.Start, span.End),
        StartIndex: span.Start,
        EndIndex: span.End,
        Color: span.Color,
        Background: span.Background,
      });
      cursor = span.End;
    }
    if (cursor < text.length) {
      out.push({
        Text: text.slice(cursor),
        StartIndex: cursor,
        EndIndex: text.length,
      });
    }
    return out;
  });

  private readonly _Metrics = computed<LayoutMetrics>(() => {
    const lhPx = this.FontSizePx() * this.LineHeightRatio();
    return {
      LineHeightPx: lhPx,
      RowPitchPx: lhPx + this.RowGapPx(),
      WrapWidth: Math.max(50, this._wrapWidth()),
    };
  });

  private readonly _SegmentsForLayout = computed<LayoutSegmentInput[]>(() =>
    this.RenderedSegments().map(s => ({
      Text: s.Text,
      StartIndex: s.StartIndex,
      EndIndex: s.EndIndex,
    })),
  );

  /** Per-component canvas context for measureText. Allocated once; font
   *  string updated when font config inputs change. */
  private _measureCtx: CanvasRenderingContext2D | null = null;
  private readonly _measureWidth = (text: string): number => {
    if (!text) return 0;
    if (!this._measureCtx) {
      const c = document.createElement('canvas').getContext('2d');
      if (!c) throw new Error('[Jinput] failed to acquire 2D context');
      this._measureCtx = c;
    }
    this._measureCtx.font = `${this.FontWeight()} ${this.FontSizePx()}px ${this.FontFamily()}`;
    return this._measureCtx.measureText(text).width;
  };

  private readonly _LaidOutSegments = computed<LaidOutSegment[]>(() =>
    LayoutSegments(this._SegmentsForLayout(), this._Metrics(), this._measureWidth),
  );

  readonly CaretRect = computed(() => {
    if (!this._focused() || !this._caretBright()) return null;
    if (this._selStart() !== this._selEnd()) return null;
    return CharPosition(this._LaidOutSegments(), this._selStart(), this._Metrics(), this._measureWidth);
  });

  readonly SelectionRects = computed(() => {
    const a = Math.min(this._selStart(), this._selEnd());
    const b = Math.max(this._selStart(), this._selEnd());
    return RangeRects(this._LaidOutSegments(), a, b, this._Metrics(), this._measureWidth);
  });

  segmentTextStyle = (s: RenderedSegment): { Color?: string } | undefined =>
    s.Color ? { Color: s.Color } : undefined;

  constructor() {
    // External Text changes (programmatic) flow into the hidden input value
    // unless the user is actively editing.
    effect(() => {
      const input = this._hiddenInput()?.nativeElement;
      if (!input) return;
      const next = this.Text();
      if (document.activeElement !== input && input.value !== next) {
        input.value = next;
        this._selStart.set(input.selectionStart ?? next.length);
        this._selEnd.set(input.selectionEnd ?? next.length);
      }
    });

    // Re-read wrap width after every reflow trigger. Jaui resolves
    // Width:100% lazily; rAF gives us the post-layout value.
    effect(() => {
      this.RenderedSegments();
      requestAnimationFrame(() => {
        const w = this._wrap()?.Node.Width;
        if (typeof w === 'number' && w > 0) this._wrapWidth.set(w);
      });
    });

    document.addEventListener('selectionchange', this._onSelectionChange);
  }

  ngOnDestroy(): void {
    document.removeEventListener('selectionchange', this._onSelectionChange);
    document.removeEventListener('pointermove', this._onDocPointerMove);
    document.removeEventListener('pointerup', this._onDocPointerUp);
    document.removeEventListener('pointercancel', this._onDocPointerUp);
    if (this._blinkTimer) clearInterval(this._blinkTimer);
  }

  // ── Public API ──────────────────────────────────────────────────
  focusInput = (): void => {
    if (this.ReadOnly()) return;
    this._hiddenInput()?.nativeElement.focus();
  };

  // ── Pointer handling ────────────────────────────────────────────
  private static readonly _BurstMs = 400;
  private static readonly _BurstPx = 5;
  private _lastClickAt = 0;
  private _lastClickX = 0;
  private _lastClickY = 0;
  private _clickCount = 0;
  private _dragGranularity: 'char' | 'word' | 'line' = 'char';
  private _dragAnchor = 0;
  private _dragPointerId: number | null = null;

  onRootPointerDown = (e: PointerEvent): void => {
    if (this.ReadOnly()) return;
    const idx = this._indexAtClient(e.clientX, e.clientY);
    if (idx === null) { this.focusInput(); return; }

    // Emit PositionClicked first; consumer can preventDefault to skip caret
    // positioning (e.g. SS tokenizer wrapper opens a token settings popup
    // and doesn't want the caret to move).
    this.PositionClicked.emit({ index: idx, event: e });
    if (e.defaultPrevented) return;

    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;

    const now = performance.now();
    const dx = e.clientX - this._lastClickX;
    const dy = e.clientY - this._lastClickY;
    const inBurst = (now - this._lastClickAt) < Jinput._BurstMs
      && Math.abs(dx) < Jinput._BurstPx
      && Math.abs(dy) < Jinput._BurstPx;
    this._clickCount = inBurst ? this._clickCount + 1 : 1;
    this._lastClickAt = now;
    this._lastClickX = e.clientX;
    this._lastClickY = e.clientY;

    const text = this.Text();
    let selA = idx, selB = idx;
    let dir: 'forward' | 'backward' | 'none' = 'none';
    let granularity: 'char' | 'word' | 'line' = 'char';

    if (e.shiftKey) {
      const curA = this._selStart();
      const curB = this._selEnd();
      let anchor: number;
      if (curA === curB) {
        anchor = curA;
      } else if (input.selectionDirection === 'backward') {
        anchor = curB;
      } else {
        anchor = curA;
      }
      selA = Math.min(anchor, idx);
      selB = Math.max(anchor, idx);
      dir = idx >= anchor ? 'forward' : 'backward';
      this._dragAnchor = anchor;
    } else if (this._clickCount === 2) {
      const w = WordRangeAt(text, idx);
      selA = w.start;
      selB = w.end;
      this._dragAnchor = w.start;
      granularity = 'word';
    } else if (this._clickCount >= 3) {
      selA = 0;
      selB = text.length;
      this._dragAnchor = 0;
      granularity = 'line';
    } else {
      this._dragAnchor = idx;
    }
    this._dragGranularity = granularity;
    this._dragPointerId = e.pointerId;
    document.addEventListener('pointermove', this._onDocPointerMove);
    document.addEventListener('pointerup', this._onDocPointerUp);
    document.addEventListener('pointercancel', this._onDocPointerUp);

    // Defer focus + selection: the browser's default pointerdown shifts
    // focus away from any currently-focused element after our listener
    // returns. setTimeout(0) lets default fire first; we re-take focus.
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(selA, selB, dir);
      this.syncSelection();
      this._scrollCaretIntoView();
    }, 0);
  };

  private _onDocPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this._dragPointerId) return;
    const idx = this._indexAtClient(e.clientX, e.clientY);
    if (idx === null) return;
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    const text = this.Text();
    let a = Math.min(this._dragAnchor, idx);
    let b = Math.max(this._dragAnchor, idx);
    if (this._dragGranularity === 'word') {
      const anchorWord = WordRangeAt(text, this._dragAnchor);
      const idxWord = WordRangeAt(text, idx);
      a = Math.min(anchorWord.start, idxWord.start);
      b = Math.max(anchorWord.end, idxWord.end);
    } else if (this._dragGranularity === 'line') {
      a = 0;
      b = text.length;
    }
    const dir = idx >= this._dragAnchor ? 'forward' : 'backward';
    input.setSelectionRange(a, b, dir as 'forward' | 'backward' | 'none');
    this.syncSelection();
    this._scrollCaretIntoView();
  };

  private _onDocPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this._dragPointerId) return;
    this._dragPointerId = null;
    document.removeEventListener('pointermove', this._onDocPointerMove);
    document.removeEventListener('pointerup', this._onDocPointerUp);
    document.removeEventListener('pointercancel', this._onDocPointerUp);
  };

  // ── Context menu ────────────────────────────────────────────────
  onRootContextMenu = (e: MouseEvent): void => {
    if (this.ReadOnly()) return;
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    this.ContextMenuRequested.emit({
      event: e,
      selStart: this._selStart(),
      selEnd: this._selEnd(),
      value: input.value,
    });
  };

  // ── Caret scroll-into-view ──────────────────────────────────────
  private _scrollCaretIntoView(): void {
    const w = this._wrap();
    if (!w) return;
    const rect = CharPosition(this._LaidOutSegments(), this._selEnd(), this._Metrics(), this._measureWidth);
    if (!rect) return;
    let p: any = w.Node.Parent;
    while (p && p.Overflow !== 'Scroll') p = p.Parent;
    if (!p) return;
    const visTop = p.ScrollY ?? 0;
    const visH = p.Height ?? 0;
    if (visH <= 0) return;
    let offsetY = 0;
    for (let n: any = w.Node; n && n !== p; n = n.Parent) offsetY += n.Y ?? 0;
    const caretTop = offsetY + rect.y;
    const caretBot = caretTop + rect.height;
    if (caretTop < visTop) {
      p.ScrollY = caretTop;
    } else if (caretBot > visTop + visH) {
      p.ScrollY = caretBot - visH;
    }
  }

  // ── Hit-testing ─────────────────────────────────────────────────
  private _indexAtClient(clientX: number, clientY: number): number | null {
    const w = this._wrap();
    const canvasEl = this._jaui?.Canvas?.Element;
    if (!w || !canvasEl) return null;
    const cRect = canvasEl.getBoundingClientRect();
    const localX = clientX - cRect.left - w.Node.X;
    const localY = clientY - cRect.top - w.Node.Y;
    return IndexAtPoint(this._LaidOutSegments(), localX, localY, this._Metrics(), this._measureWidth);
  }

  // ── Native input bridge ─────────────────────────────────────────
  onInput = (event: Event): void => {
    const value = (event.target as HTMLInputElement).value;
    this.Text.set(value);
    this.syncSelection();
  };

  onKeyDown = (e: KeyboardEvent): void => {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;
    const key = e.key.toLowerCase();
    if (key === 'a') {
      e.preventDefault();
      const el = this._hiddenInput()?.nativeElement;
      if (!el) return;
      el.setSelectionRange(0, el.value.length);
      this.syncSelection();
      e.stopPropagation();
      return;
    }
    if (key === 'c' || key === 'x' || key === 'v') {
      e.stopPropagation();
    }
  };

  onFocus = (): void => {
    this._focused.set(true);
    this.syncSelection();
    this._restartBlink();
    this.FocusChanged.emit(true);
  };

  onBlur = (): void => {
    this._focused.set(false);
    if (this._blinkTimer) {
      clearInterval(this._blinkTimer);
      this._blinkTimer = null;
    }
    this.FocusChanged.emit(false);
  };

  syncSelection = (): void => {
    const el = this._hiddenInput()?.nativeElement;
    if (!el) return;
    this._selStart.set(el.selectionStart ?? 0);
    this._selEnd.set(el.selectionEnd ?? 0);
    this._caretBright.set(true);
    this._restartBlink();
  };

  private _onSelectionChange = (): void => {
    const el = this._hiddenInput()?.nativeElement;
    if (!el || document.activeElement !== el) return;
    this.syncSelection();
  };

  private _restartBlink = (): void => {
    if (this._blinkTimer) clearInterval(this._blinkTimer);
    this._blinkTimer = setInterval(() => {
      this._caretBright.update(v => !v);
    }, 530);
  };
}
