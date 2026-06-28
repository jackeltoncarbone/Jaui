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
  /** Optional CSS class applied to the rendered `<jext>` for this span,
   *  in addition to the default `JinputSegment`. Lets consumers attach
   *  per-span hover / focus / theme styling via JSS without per-span
   *  Angular components. */
  Class?: string;
  /** Optional per-span font weight override. Inline on the segment's
   *  textStyle — survives the class-merge order issue that prevents
   *  JSS-driven `:Hover` weight rules from sticking (see segmentTextStyle
   *  below). */
  FontWeight?: number;
}

/** A remote collaborator's caret/selection rendered as a non-blinking
 *  overlay inside this input. Used by Yjs-awareness-driven live editing
 *  (Drill page presence) — Jinput just paints what it's told. */
export interface JinputPeerCaret {
  /** Stable key for `@for track` so a tab moving the caret animates
   *  position rather than swapping DOM. */
  Key: string;
  Start: number;
  End: number;
  /** CSS color for both the 2px caret line and the rgba selection halo
   *  (Jinput drops opacity to ~28% for the halo so multiple peers'
   *  selections layer without becoming opaque mud). */
  Color: string;
  /** Display name shown on hover in a small pill above the caret. */
  Name?: string;
  /** Whether the peer's editor currently has focus. When false the
   *  caret line is suppressed (a stale blinking artifact); selection
   *  halo always renders. Defaults to true if absent. */
  Focused?: boolean;
}

interface RenderedSegment extends LayoutSegmentInput {
  Color?: string;
  Background?: string;
  Class?: string;
  FontWeight?: number;
}

/** Convert any CSS color string (#rgb / #rrggbb / hsl(...) / rgb(...)) to
 *  an rgba(...) value at the supplied alpha. Used for peer selection
 *  halos — same hue as their accent caret, just translucent so overlapping
 *  peers layer rather than going opaque. */
function _withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  if (c.startsWith('#')) {
    const hex = c.slice(1);
    const full = hex.length === 3 ? hex.split('').map(x => x + x).join('') : hex;
    if (full.length !== 6) return c;
    const r = parseInt(full.slice(0, 2), 16);
    const g = parseInt(full.slice(2, 4), 16);
    const b = parseInt(full.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (c.startsWith('hsl(')) return c.replace(/^hsl\(/, 'hsla(').replace(/\)$/, `, ${alpha})`);
  if (c.startsWith('rgb(')) return c.replace(/^rgb\(/, 'rgba(').replace(/\)$/, `, ${alpha})`);
  return c;
}

@Component({
  selector: 'jinput',
  standalone: true,
  imports: [Jiv, Jext, Jyle],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <jyle [source]="JssSource" />

    <jiv [class]="(MultiLine() ? 'JinputRoot' : 'JinputRoot JinputRootSingleLine') + (ReadOnly() ? ' JinputReadOnly' : '')"
      (pointerdown)="onRootPointerDown($event)"
      (contextmenu)="onRootContextMenu($event)">
      <jiv #wrap class="JinputWrap"
        [childLayout]="{ Height: LaidOutHeight() + 'px' }">
        @if (showPlaceholder()) {
          <jext class="JinputPlaceholder" [text]="Placeholder()" [textStyle]="placeholderTextStyle()" />
        } @else {
          <!-- Selection rects FIRST so segment text paints on top. Live
               SelectionRects() (not a snapshot): the engine's implicit
               Opacity:Presence binding handles BOTH fade-in (mount) and
               fade-out (RequestLeave on ngOnDestroy via the Presence
               spec). An inline Opacity here would override that binding
               and break the exit fade — leaving rects would render at
               full opacity for the entire spring settle and then pop.
               Track by rect position so a fresh selection mounts fresh
               jivs at the new position instead of recycling stale ones. -->
          @for (rect of SelectionRects(); track rect.y + ':' + rect.x) {
            <jiv
              class="JinputSelectionRect"
              [style]="{ BorderRadius: (rect.height * 0.4) + 'px' }"
              [childLayout]="{
                Position: 'Placed',
                Left: rect.x + 'px',
                Top: rect.y + 'px',
                Width: rect.width + 'px',
                Height: rect.height + 'px',
              }" />
          }
          @for (laid of LaidOutSegments(); track laid.Seg.StartIndex + ':' + laid.Row) {
            <jext
              [class]="segmentClass(laid.Seg)"
              [text]="laid.Seg.Text"
              [textStyle]="segmentTextStyle(laid.Seg)"
              [childLayout]="{
                Position: 'Placed',
                Left: laid.X + 'px',
                Top: laid.Y + 'px',
                Width: laid.Width + 'px',
                Height: laid.Height + 'px',
              }" />
          }
          @if (CaretRect(); as cr) {
            <jiv
              class="JinputCaret"
              [childLayout]="{
                Position: 'Placed',
                Left: cr.x + 'px',
                Top: cr.y + 'px',
                Width: '2.5px',
                Height: cr.height + 'px',
              }" />
          }
          <!-- Peer carets + selection halos. Painted AFTER the local
               caret so multiple peers stack visibly; selection halos
               use the peer's accent color at low opacity so overlapping
               regions don't go opaque. Non-blinking — only the local
               caret blinks. -->
          <!-- Per-peer group jiv. The default Opacity:Presence binding
               lives on this wrapper so when a peer leaves the room
               entirely (@for removes the group → ngOnDestroy →
               RequestLeave), the Presence spring fades from 1→0 over
               ~400ms and cascades through to all children visually
               (per Presence.md "nested exits"). Children still set
               their own Opacity overrides for in-place state changes
               (selection toggle, hover) — those compose with the
               parent's Presence-driven opacity at render time. -->
          @for (peer of PeerCaretRects(); track peer.Key) {
            <jiv class="JinputPeerGroup">
              @for (rect of peer.Ranges; track rect.y + ':' + rect.x) {
                <jiv
                  class="JinputPeerSelectionRect"
                  [style]="{
                    Background: peer.SelectionColor,
                    BorderRadius: (rect.height * 0.4) + 'px'
                  }"
                  [childLayout]="{
                    Position: 'Placed',
                    Left: rect.x + 'px',
                    Top: rect.y + 'px',
                    Width: rect.width + 'px',
                    Height: rect.height + 'px',
                  }" />
              }
              @if (peer.Caret; as cr) {
                <jiv
                  class="JinputPeerCaretHit"
                  [childLayout]="{
                    Position: 'Placed',
                    Left: (cr.x - 7) + 'px',
                    Top: cr.y + 'px',
                    Width: '16px',
                    Height: cr.height + 'px',
                  }">
                  <jiv class="JinputPeerCaretLine"
                    [style]="{ Background: peer.Color }"
                    [childLayout]="{
                      Position: 'Placed',
                      Left: '7px',
                      Top: '0px',
                      Width: '2px',
                      Height: cr.height + 'px',
                    }" />
                </jiv>
              }
              @if (peer.LabelAnchor; as la) {
                <jext
                  class="JinputPeerCaretLabel"
                  [text]="peer.Name"
                  [style]="{
                    Background: peer.Color,
                    Opacity: _hoveredPeerKey() === peer.Key ? '1' : '0'
                  }"
                  [childLayout]="{
                    Position: 'Placed',
                    Left: la.x + 'px',
                    Top: (la.y - 20) + 'px'
                  }" />
              }
            </jiv>
          }
        }
      </jiv>
    </jiv>

    <textarea
      #hiddenInput
      class="HiddenInput"
      name="JinputHidden"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      rows="1"
      [readOnly]="ReadOnly()"
      (input)="onInput($event)"
      (compositionstart)="onCompositionStart()"
      (compositionend)="onCompositionEnd()"
      (focus)="onFocus()"
      (blur)="onBlur()"
      (keydown)="onKeyDown($event)"
      (keyup)="syncSelection()"
      (click)="syncSelection()"></textarea>
  `,
  styles: [`
    :host { display: contents; }
    .HiddenInput {
      /* Default: parked off-screen. iOS Safari has a long-standing carve-out
         for off-screen inputs at -9999px that lets programmatic focus()
         open the soft keyboard outside a strict user-gesture window. Moving
         the textarea on-screen broke keyboard-on-tap. Desktop platforms
         (where Windows TSF / Win+V cares about a real viewport-anchored
         input) opt into caret-tracked positioning via the constructor
         effect below; mobile leaves it parked here. */
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
      caret-color: transparent;
      color: transparent;
      background: transparent;
      overflow: hidden;
      resize: none;
    }
  `],
})
export class Jinput implements OnDestroy {
  readonly JssSource = JinputJss;

  // ── Inputs ──────────────────────────────────────────────────────
  readonly Text = model('');
  readonly Spans = input<readonly JinputSpan[]>([]);
  /** Remote collaborators' carets/selections overlaid on this input.
   *  Painted alongside the local caret using the same layout primitives. */
  readonly PeerCarets = input<readonly JinputPeerCaret[]>([]);
  readonly Placeholder = input('');
  readonly ReadOnly = input(false);
  /** Allow newline characters in the model. When false (default), Enter
   *  emits Submitted instead of inserting a newline, and pasted text has
   *  newlines stripped. Set true on long-form / multi-paragraph editors. */
  readonly MultiLine = input(false);

  /** Font config used both for canvas measureText (layout) and JSS-driven
   *  rendering. Defaults to system-ui at 20px (16pt × 1.25 default scale).
   *  Wrappers (Jwift's TextInput, app-level styles) override these. */
  readonly FontFamily = input('system-ui, sans-serif');
  readonly FontSizePx = input(20);
  readonly FontWeight = input(400);
  readonly LineHeightRatio = input(1.6);
  readonly RowGapPx = input(5);
  /** Placeholder slant. Defaults to the historical italic (set by the
   *  `JinputPlaceholder` JSS class); consumers can pass 'Normal' for a
   *  straight placeholder without touching the shared class. */
  readonly PlaceholderFontStyle = input<'Normal' | 'Italic'>('Italic');

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
  /** Enter (without Shift) when not in multi-line mode. Consumer is expected
   *  to use this to commit / submit. Shift+Enter is always ignored — leave
   *  Shift for newline insertion in MultiLine consumers. */
  /** Local selection changed — fires on caret move / drag-extend / keyboard
   *  navigation. Consumers use this to broadcast the selection over a
   *  collaboration channel (Yjs awareness etc.) so remote users see live
   *  cursors. The two indices are equal for a collapsed caret. */
  readonly SelectionChanged = output<{ start: number; end: number }>();
  readonly Submitted = output<KeyboardEvent>();
  /** Esc — consumer is expected to dismiss / cancel / revert. The default
   *  action (preventing default to swallow Esc) is the consumer's call. */
  readonly Cancelled = output<KeyboardEvent>();

  // ── Refs ────────────────────────────────────────────────────────
  private readonly _jaui = inject(Jaui, { optional: true });
  private readonly _hiddenInput = viewChild<ElementRef<HTMLTextAreaElement>>('hiddenInput');
  private readonly _wrap = viewChild<Jiv>('wrap');

  // ── Internal state ──────────────────────────────────────────────
  private readonly _selStart = signal(0);
  private readonly _selEnd = signal(0);
  private readonly _focused = signal(false);
  private readonly _caretBright = signal(true);
  private _blinkTimer: ReturnType<typeof setInterval> | null = null;
  private readonly _wrapWidth = signal(600);
  // Bumped when a font that affects measurement finishes loading, so
  // computed signals that depend on _measureWidth re-run with the now-
  // correct glyph metrics. measureText falls back to system-ui until
  // the @font-face Inter lands in the canvas2d font registry; system-ui
  // is wider than Inter, so lines wrap earlier than Jaui's renderer
  // (which has Inter primed in the worker's OffscreenCanvas) and leave
  // a visible right-margin gap on every row.
  private readonly _fontGen = signal(0);

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
        Class: span.Class,
        FontWeight: span.FontWeight,
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
      Color: s.Color,
      Background: s.Background,
      Class: s.Class,
      FontWeight: s.FontWeight,
    })),
  );

  /** Total laid-out height in CSS px — used to size the wrap container so
   *  Position:Placed children don't collapse to zero height. Computed as
   *  bottom of the last laid-out row + a one-line buffer for the trailing
   *  caret position when text ends with `\n`. */
  readonly LaidOutHeight = computed<number>(() => {
    const laid = this.LaidOutSegments();
    const m = this._Metrics();
    if (laid.length === 0) return m.LineHeightPx;
    let maxBottom = 0;
    for (const s of laid) {
      const b = s.Y + s.Height;
      if (b > maxBottom) maxBottom = b;
    }
    return maxBottom;
  });

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

  readonly LaidOutSegments = computed<LaidOutSegment[]>(() => {
    // Track _fontGen so a font-load completion re-runs this with
    // measurement values reflecting the loaded font.
    this._fontGen();
    return LayoutSegments(this._SegmentsForLayout(), this._Metrics(), this._measureWidth);
  });

  readonly CaretRect = computed(() => {
    if (!this._focused() || !this._caretBright()) return null;
    if (this._selStart() !== this._selEnd()) return null;
    return CharPosition(this.LaidOutSegments(), this._selStart(), this._Metrics(), this._measureWidth);
  });

  // Small halo around each selection line. Shared with Selection.Manager
  // (see SELECTION_PAD_X / SELECTION_PAD_Y there) so plain-text and input
  // selection halos have identical visual padding.
  private readonly _SELECTION_PAD_X = 3;
  private readonly _SELECTION_PAD_Y = 2;

  readonly SelectionRects = computed(() => {
    const a = Math.min(this._selStart(), this._selEnd());
    const b = Math.max(this._selStart(), this._selEnd());
    const raw = RangeRects(this.LaidOutSegments(), a, b, this._Metrics(), this._measureWidth);
    const px = this._SELECTION_PAD_X;
    const py = this._SELECTION_PAD_Y;
    return raw.map(r => ({
      x: r.x - px,
      y: r.y - py,
      width: r.width + px * 2,
      height: r.height + py * 2,
    }));
  });

  /** Per-peer caret + selection rects in the same coordinate space as the
   *  local caret. Selection rects are returned even for collapsed peers
   *  (empty array) so the template can iterate uniformly. The caret rect
   *  is computed via the existing CharPosition helper so peer carets land
   *  on the exact same pixel a local caret would for that index. */
  readonly PeerCaretRects = computed(() => {
    const peers = this.PeerCarets();
    if (peers.length === 0) return [];
    const laid = this.LaidOutSegments();
    const m = this._Metrics();
    const px = this._SELECTION_PAD_X;
    const py = this._SELECTION_PAD_Y;
    return peers.map((p) => {
      const collapsed = p.Start === p.End;
      const caret = collapsed
        ? CharPosition(laid, p.Start, m, this._measureWidth)
        : null;
      const ranges = collapsed
        ? []
        : RangeRects(laid, Math.min(p.Start, p.End), Math.max(p.Start, p.End), m, this._measureWidth)
            .map(r => ({
              x: r.x - px,
              y: r.y - py,
              width: r.width + px * 2,
              height: r.height + py * 2,
            }));
      const renderCaret = p.Focused === false ? null : caret;
      // Anchor for the floating name pill. Prefer the caret when one
      // exists (gives the pill a tight reference point); otherwise
      // anchor to the top-left of the first selection rect.
      const labelAnchor = renderCaret
        ? { x: renderCaret.x, y: renderCaret.y }
        : (ranges[0] ? { x: ranges[0].x, y: ranges[0].y } : null);
      return {
        Key: p.Key,
        Color: p.Color,
        Name: p.Name && p.Name.length > 0 ? p.Name : 'Editor',
        // Selection halo: peer accent at 0.32 alpha — matches the
        // native local-selection class exactly (rgba(_, _, _, 0.32)
        // in JinputSelectionRect) so peer selections read as the
        // same primitive, just colored for identity.
        SelectionColor: _withAlpha(p.Color, 0.32),
        // Caret line only renders when the peer's editor is focused —
        // a blinking line at a stale position is noise. The selection
        // halo (Ranges) keeps rendering regardless because it
        // represents content the peer selected on purpose.
        Caret: renderCaret,
        Ranges: ranges,
        LabelAnchor: labelAnchor,
      };
    });
  });

  // Inline TextStyle on every rendered segment so the visual `<jext>`
  // renders at the SAME font metrics jinput uses for canvas measureText
  // (FontSizePx / FontFamily / FontWeight / LineHeightRatio). Without
  // this, segments fell back to whatever the JinputSegment class
  // resolved to in the registry — and class merging is last-write-wins,
  // so an outer consumer that sideloaded JinputSegment with FontSize
  // would still get clobbered by jinput's own JinputSegment merge when
  // jinput mounted later in the tree. Inline textStyle is per-instance
  // and reactive, so it always tracks the current input values.
  segmentTextStyle = (s: RenderedSegment): {
    FontFamily: string;
    FontSize: string;
    FontWeight: number;
    LineHeight: string;
    Color?: string;
  } => ({
    FontFamily: this.FontFamily(),
    FontSize: `${this.FontSizePx()}px`,
    FontWeight: s.FontWeight ?? this.FontWeight(),
    LineHeight: String(this.LineHeightRatio()),
    ...(s.Color ? { Color: s.Color } : {}),
  });

  segmentClass = (s: RenderedSegment): string =>
    s.Class ? `JinputSegment ${s.Class}` : 'JinputSegment';

  // Same metric-locking story as segmentTextStyle, applied to the
  // placeholder `<jext>` so the empty-state text renders at the same
  // size as real input would.
  placeholderTextStyle = (): {
    FontFamily: string;
    FontSize: string;
    FontWeight: number;
    LineHeight: string;
    FontStyle: 'Normal' | 'Italic';
  } => ({
    FontFamily: this.FontFamily(),
    FontSize: `${this.FontSizePx()}px`,
    FontWeight: this.FontWeight(),
    LineHeight: String(this.LineHeightRatio()),
    FontStyle: this.PlaceholderFontStyle(),
  });

  constructor() {
    // SS-200: seed the wrap width from the canvas's real DOM width before the
    // first layout pass. Jaui resolves node widths over later frames (they read
    // 0 on the first tick), so without this the first paint falls back to the
    // 600px default and long text wraps at ~half the container width before
    // snapping out a frame later. The canvas is the only synchronously
    // measurable real width; the rAF poll (_startLayoutWidthPoll) still refines
    // to the exact wrap width. Safe fallback: if the canvas isn't sized yet we
    // keep the 600 default — never worse than before.
    const initialCanvasWidth = this._jaui?.Canvas?.Element?.getBoundingClientRect().width;
    if (initialCanvasWidth && initialCanvasWidth > 0) this._wrapWidth.set(initialCanvasWidth);

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
    // Width:100% lazily over one or more frames after Angular CD finishes,
    // so a single rAF sometimes finds Node.Width still 0 — retry a few
    // frames before giving up. Without this, the initial layout uses the
    // signal's default and text either renders un-wrapped (initial value
    // too large) or one-char-per-line (initial value too small) until a
    // text change happens to retrigger the effect.
    //
    // Subscribe the wrap Jiv to per-frame rect snapshots the first frame
    // it's available — JivHandle geometry reads return 0 unless WatchRect
    // is on, so without this the rAF retries above always see Width: 0
    // and we fall back to the default WrapWidth (600px), which makes long
    // prompts wrap at the wrong column.
    effect(() => {
      this.RenderedSegments();
      const wrap = this._wrap();
      if (wrap && !this._wrapWatched) {
        // Watch the wrap so its X/Y/Width/Height stay fresh for click
        // hit-testing in worker mode. (We don't drive _wrapWidth off
        // this Width — see _pollLayoutWidth below.)
        wrap.Node.WatchRect(true);
        this._wrapWatched = true;
        this._startLayoutWidthPoll();
      }
      this._scheduleWrapRead();
    });

    // (Previously: a SnapLayout=true / next-frame=false dance ran here on
    // every viewChildren change to paper over a layout leak — the worker's
    // subtree solver was reading parent Width/Height from the animator's
    // mid-spring values, which made paste / token-driven re-segmentation
    // sometimes resolve a segment to a Y that fell within Spring.Set's
    // 0.1px deadband on the next solve and stuck there. The leak is now
    // closed at the source in Element.LayoutX/Y/Width/Height — segments
    // spring to their correct target naturally, no snap dance needed.)

    // Desktop only: pin the hidden textarea to the visual caret. Windows
    // Text Services Framework (Win+V clipboard history) and IME candidate
    // boxes on Chromium register their context against the focused input's
    // bounding rect. An off-screen input registers in the DOM but TSF drops
    // it as "not in viewport", which is why Win+V acted like no text input
    // was focused. Mobile is gated OUT — iOS Safari has a long-standing
    // carve-out for off-screen inputs that lets programmatic `focus()`
    // open the soft keyboard outside a strict user-gesture window. Moving
    // the textarea on-screen on mobile breaks keyboard-on-tap; the OS
    // paste / IME UI on touch devices anchors to the visible selection
    // rect anyway, so caret tracking buys nothing there.
    //
    // Track selection (not CaretRect), so the position doesn't jitter with
    // the caret-blink cycle — CaretRect goes null on the off-phase of the
    // blink and when the user has a selection range, both of which would
    // bounce the textarea between the caret and the wrap top-left.
    if (!Jinput._isMobileTouch()) {
      effect(() => {
        const inputEl = this._hiddenInput()?.nativeElement;
        if (!inputEl) return;
        const canvasEl = this._jaui?.Canvas?.Element;
        const wrap = this._wrap();
        if (!canvasEl || !wrap) return;
        // Subscribe to caret position via the selection signals + laid-out
        // segments so the effect re-runs on caret move / wrap / text change.
        const laid = this.LaidOutSegments();
        const metrics = this._Metrics();
        const sel = this._selEnd();
        const rect = canvasEl.getBoundingClientRect();
        let viewportX = rect.left + wrap.Node.X;
        let viewportY = rect.top + wrap.Node.Y;
        if (laid.length > 0) {
          const cp = CharPosition(laid, sel, metrics, this._measureWidth);
          viewportX += cp.x;
          viewportY += cp.y;
        }
        // Clamp to viewport so the textarea never lands off-screen — TSF
        // ignores out-of-bounds inputs the same way it ignores top:-9999px.
        const vx = Math.max(0, Math.min(viewportX, window.innerWidth - 1));
        const vy = Math.max(0, Math.min(viewportY, window.innerHeight - 1));
        inputEl.style.left = `${vx}px`;
        inputEl.style.top = `${vy}px`;
      });
    }

    document.addEventListener('selectionchange', this._onSelectionChange);
    // Wrap re-flows on viewport resize even when text hasn't changed; without
    // this listener long content stays wrapped to the old width after the
    // user resizes the window.
    window.addEventListener('resize', this._onWindowResize);
    window.addEventListener('pointermove', this._onWindowHoverMove);
    // SS-199: dismiss the keyboard when the user taps outside the input. The
    // hidden textarea is offscreen, so a tap elsewhere never moves DOM focus
    // on its own — without this the soft keyboard stays up after the user
    // leaves the field. Capture phase so we see the tap before it's consumed.
    window.addEventListener('pointerdown', this._onPointerDownDismiss, true);

    // Re-run layout once the @font-face font lands in the canvas2d font
    // registry — measureText falls back to a wider system font until
    // then, which makes lines wrap earlier than Jaui's renderer (whose
    // OffscreenCanvas has the font primed earlier) and leaves a visible
    // right-edge gap on every row. document.fonts.ready resolves when
    // every pending @font-face has loaded; calling .load() for our
    // specific font kicks the browser to fetch it if it hasn't already.
    if (typeof document !== 'undefined' && document.fonts) {
      const fontSpec = `${this.FontWeight()} ${this.FontSizePx()}px ${this.FontFamily()}`;
      document.fonts.load(fontSpec).finally(() => this._fontGen.update(v => v + 1));
      document.fonts.ready.then(() => this._fontGen.update(v => v + 1));
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('selectionchange', this._onSelectionChange);
    document.removeEventListener('pointermove', this._onDocPointerMove);
    document.removeEventListener('pointerup', this._onDocPointerUp);
    document.removeEventListener('pointercancel', this._onDocPointerUp);
    window.removeEventListener('resize', this._onWindowResize);
    window.removeEventListener('pointermove', this._onWindowHoverMove);
    window.removeEventListener('pointerdown', this._onPointerDownDismiss, true);
    if (this._blinkTimer) clearInterval(this._blinkTimer);
    this._clearLongPressTimer();
    if (this._wrapReadFrame !== null) cancelAnimationFrame(this._wrapReadFrame);
    if (this._layoutPollFrame !== null) {
      cancelAnimationFrame(this._layoutPollFrame);
      this._layoutPollFrame = null;
    }
    if (this._wrapWatched) {
      const wrap = this._wrap()?.Node;
      wrap?.WatchRect(false);
      const parent = (wrap?.Parent ?? null) as { WatchRect?: (b: boolean) => void; Parent?: { WatchRect?: (b: boolean) => void } } | null;
      parent?.WatchRect?.(false);
      parent?.Parent?.WatchRect?.(false);
      this._wrapWatched = false;
      this._parentWatched = false;
      this._grandWatched = false;
    }
  }

  private _wrapReadFrame: number | null = null;
  private _wrapWatched = false;
  private _layoutPollFrame: number | null = null;
  private _startLayoutWidthPoll = (): void => {
    if (this._layoutPollFrame !== null) return;
    const tick = (): void => {
      this._layoutPollFrame = requestAnimationFrame(tick);
      const wrap = this._wrap()?.Node;
      if (!wrap) return;
      // WatchRect each candidate so the worker keeps emitting snapshots
      // (own cache stays fresh). LARGEST of the chain wins — the wrap
      // itself is `Wrap: Wrap` and its Width sticks at wrapped-content
      // width once text ever wraps, but its parent JinputRoot tracks
      // its own parent (Width: 100%) and grows back. We can't predict
      // which ancestor is reliably monotonic, so take the max across
      // the closest ancestors we can reach.
      type NodeLike = { Width: number; WatchRect: (b: boolean) => void; Parent?: NodeLike | null };
      const parent = (wrap.Parent ?? null) as NodeLike | null;
      const grand = (parent?.Parent ?? null) as NodeLike | null;
      if (parent && !this._parentWatched) {
        parent.WatchRect(true);
        this._parentWatched = true;
      }
      if (grand && !this._grandWatched) {
        grand.WatchRect(true);
        this._grandWatched = true;
      }
      let best = wrap.Width ?? 0;
      if (parent && parent.Width > best) best = parent.Width;
      if (grand && grand.Width > best) best = grand.Width;
      if (best > 0 && best !== this._wrapWidth()) this._wrapWidth.set(best);
    };
    tick();
  };
  private _parentWatched = false;
  private _grandWatched = false;

  private _scheduleWrapRead = (attempt: number = 0): void => {
    if (this._wrapReadFrame !== null) return;
    this._wrapReadFrame = requestAnimationFrame(() => {
      this._wrapReadFrame = null;
      // Read from the wrap's parent for the same monotonic-tracking
      // reason as the OnRectSnapshot hookup above.
      const wrap = this._wrap()?.Node;
      const src = wrap?.Parent ?? wrap;
      const w = src?.Width;
      if (typeof w === 'number' && w > 0) {
        if (w !== this._wrapWidth()) this._wrapWidth.set(w);
        return;
      }
      if (attempt < 10) this._scheduleWrapRead(attempt + 1);
    });
  };

  private _onWindowResize = (): void => {
    this._scheduleWrapRead();
  };

  // ── Public API ──────────────────────────────────────────────────
  /** Programmatically focus the input — moves the caret to the end if no
   *  selection is active, makes the caret visible, and re-arms the blink
   *  cycle. Safe to call from any time after construction; if the hidden
   *  input element isn't in the DOM yet (very early lifecycle), the call
   *  is a no-op rather than throwing.
   *
   *  Mobile keyboard quirk: on iOS Safari and Android Chrome, calling
   *  `focus()` on an element that ALREADY has document focus is a no-op —
   *  it doesn't fire a focus event, which means the on-screen keyboard
   *  doesn't reopen. If the user dismissed the keyboard via tap-outside
   *  or swipe-down, our hidden textarea is still focused in the DOM but
   *  the keyboard is gone. To get it back, we have to blur first so the
   *  subsequent focus() actually fires a fresh focus event. */
  Focus = (): void => {
    if (this.ReadOnly()) return;
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    this._focusHidden(input);
    // Move caret to end if currently selectionless and the input has text.
    // Common case for "show placement bar with prefilled text and let the
    // user keep typing where they left off".
    const len = input.value.length;
    if (input.selectionStart === input.selectionEnd && input.selectionStart === 0 && len > 0) {
      input.setSelectionRange(len, len);
    }
    this.syncSelection();
  };

  /** Programmatically blur the input and dismiss the on-screen keyboard
   *  (SS-199). The hidden textarea sits offscreen, so canvas taps never move
   *  DOM focus away from it on their own — without an explicit blur the soft
   *  keyboard stays up after the user leaves the field. Consumers call this on
   *  tap-outside / submit. `onBlur` then fires and emits FocusChanged(false). */
  Blur = (): void => {
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    if (document.activeElement === input) input.blur();
  };

  /** Tap-outside dismissal (SS-199). Fires for every real pointerdown on the
   *  page; when we're focused and the tap lands outside this input's text
   *  wrap, blur so the keyboard leaves. Taps inside the wrap are ignored so
   *  caret/selection gestures still work. */
  private _onPointerDownDismiss = (e: PointerEvent): void => {
    if (!this._focused()) return;
    const wrap = this._wrap();
    const canvasEl = this._jaui?.Canvas?.Element;
    if (!wrap || !canvasEl) return;
    const cRect = canvasEl.getBoundingClientRect();
    const localX = e.clientX - cRect.left;
    const localY = e.clientY - cRect.top;
    const inWrap = localX >= wrap.Node.X && localX < wrap.Node.X + wrap.Node.Width
                && localY >= wrap.Node.Y && localY < wrap.Node.Y + wrap.Node.Height;
    if (!inWrap) this.Blur();
  };

  /** Focus the hidden textarea such that the on-screen keyboard reopens
   *  reliably on mobile. The blur step is the linchpin: iOS Safari and
   *  Android Chrome no-op a `focus()` call on an already-focused element,
   *  which is exactly the state we're in when the user dismissed the
   *  keyboard (via tap-outside or swipe-down) without giving up DOM focus.
   *  Blur first → next focus() fires fresh and the keyboard reappears. */
  private _focusHidden = (input: HTMLTextAreaElement): void => {
    if (document.activeElement === input) input.blur();
    input.focus();
  };

  /** Touch-primary mobile detection — used to gate the caret-tracked
   *  textarea positioning effect. We rely on the same media-query signal
   *  the rest of the app uses for mobile / desktop branching:
   *  `(pointer: coarse)` is true on iOS Safari and Android Chrome (plus
   *  any device whose primary pointer is a finger). Cached once because
   *  the result doesn't change without a full page reload. */
  private static _MobileTouchCached: boolean | null = null;
  private static _isMobileTouch(): boolean {
    if (Jinput._MobileTouchCached !== null) return Jinput._MobileTouchCached;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      Jinput._MobileTouchCached = false;
      return false;
    }
    const result = window.matchMedia('(pointer: coarse)').matches;
    Jinput._MobileTouchCached = result;
    return result;
  }

  // ── Pointer handling ────────────────────────────────────────────
  private static readonly _BurstMs = 400;
  private static readonly _BurstPx = 5;
  // Touch long-press = native "select word" gesture. The hidden <input>
  // sits at top:-9999px so the browser's own selection UI never shows up
  // on the canvas; we mimic it with a timer here.
  private static readonly _LongPressMs = 500;
  private static readonly _LongPressMovePx = 8;
  private _lastClickAt = 0;
  private _lastClickX = 0;
  private _lastClickY = 0;
  private _clickCount = 0;
  private _dragGranularity: 'char' | 'word' | 'line' = 'char';
  private _dragAnchor = 0;
  private _dragPointerId: number | null = null;
  // SS-199: whether the active drag began from a touch pointer. A plain
  // single-finger touch drag must scroll, not char-select.
  private _dragIsTouch = false;
  // SS-199: touch is dragging an existing selection's end to adjust it. The
  // selection edges are the grab targets (no drawn handles); char-drag stays
  // live in this mode instead of being inert.
  private _draggingSelectionEnd = false;
  private _longPressTimer: ReturnType<typeof setTimeout> | null = null;
  private _pointerDownX = 0;
  private _pointerDownY = 0;

  onRootPointerDown = (e: PointerEvent): void => {
    if (this.ReadOnly()) return;
    // Browser long-press suppression for touch happens in Jaui Core's
    // canvas pointerdown listener — the event we receive here is a clone
    // synthesized by the Jiv bridge, so preventDefault on it can't reach
    // back to the original native event.
    const idx = this._indexAtClient(e.clientX, e.clientY);
    if (idx === null) { this.Focus(); return; }

    // Emit PositionClicked first; consumer can preventDefault to skip caret
    // positioning (e.g. SS tokenizer wrapper opens a token settings popup
    // and doesn't want the caret to move).
    this.PositionClicked.emit({ index: idx, event: e });

    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;

    if (e.defaultPrevented) {
      // Consumer skipped caret positioning, but the user still clicked the
      // editable surface — keep focus so subsequent typing lands here. Same
      // setTimeout(0) reason as the full-path focus below: browser default
      // pointerdown shifts focus away after our handler returns.
      setTimeout(() => this._focusHidden(input), 0);
      return;
    }

    // SS-199: touch grab of an existing selection's end. The selection edges
    // themselves are the handles (no drawn knobs) — touching near an end and
    // dragging moves that end while the opposite end stays anchored.
    if (e.pointerType === 'touch') {
      const ss = this._selStart();
      const se = this._selEnd();
      if (ss !== se) {
        const NEAR = 2; // chars of slop for a fingertip near an edge
        if (Math.abs(idx - ss) <= NEAR || Math.abs(idx - se) <= NEAR) {
          this._dragAnchor = Math.abs(idx - ss) <= Math.abs(idx - se) ? se : ss;
          this._dragGranularity = 'char';
          this._draggingSelectionEnd = true;
          this._dragIsTouch = true;
          this._dragPointerId = e.pointerId;
          this._pointerDownX = e.clientX;
          this._pointerDownY = e.clientY;
          this._clearLongPressTimer();
          document.addEventListener('pointermove', this._onDocPointerMove);
          document.addEventListener('pointerup', this._onDocPointerUp);
          document.addEventListener('pointercancel', this._onDocPointerUp);
          return; // keep the selection; the drag adjusts the grabbed end
        }
      }
    }

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
      const row = this._rowRangeAt(idx);
      selA = row.start;
      selB = row.end;
      this._dragAnchor = row.start;
      granularity = 'line';
    } else {
      this._dragAnchor = idx;
    }
    this._dragGranularity = granularity;
    this._dragPointerId = e.pointerId;
    this._dragIsTouch = e.pointerType === 'touch';
    this._draggingSelectionEnd = false;
    this._pointerDownX = e.clientX;
    this._pointerDownY = e.clientY;
    document.addEventListener('pointermove', this._onDocPointerMove);
    document.addEventListener('pointerup', this._onDocPointerUp);
    document.addEventListener('pointercancel', this._onDocPointerUp);

    // Touch long-press → select the word under the finger. Only kicks in
    // for single-finger taps (not shift/burst paths, which already set a
    // larger granularity). Movement beyond the threshold or pointer-up
    // before the timer fires cancels it — see _onDocPointerMove /
    // _onDocPointerUp.
    if (e.pointerType === 'touch' && granularity === 'char' && !e.shiftKey) {
      this._clearLongPressTimer();
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = null;
        this._promoteToWordSelection(idx);
      }, Jinput._LongPressMs);
    }

    // Focus + select. On real browser pointerdown the default action
    // shifts focus away from any currently-focused element after our
    // listener returns, so we have to setTimeout(0) and re-take focus.
    // But Jaui-bridged synthetic events are pure DOM-dispatched clones
    // (no native default), so the defer is unnecessary AND on mobile
    // it actively breaks: `setSelectionRange` called outside the user
    // gesture window doesn't commit the caret position. Detect synthetic
    // events via the `__jauiBridged` marker the bridge stamps and run
    // the selection synchronously for those.
    const isBridged = (e as PointerEvent & { __jauiBridged?: boolean }).__jauiBridged === true;
    const applySelection = (): void => {
      // Don't blur-then-focus when we're inside the same gesture — that
      // sequence works for "reopen keyboard" (separate gesture) but
      // breaks here because the blur clears the upcoming setSelectionRange
      // on iOS Safari. Plain focus() is enough: if the element is already
      // focused the call no-ops, and setSelectionRange still commits.
      if (document.activeElement !== input) input.focus();
      input.setSelectionRange(selA, selB, dir);
      this.syncSelection();
      this._scrollCaretIntoView();
    };
    if (isBridged) applySelection();
    else setTimeout(applySelection, 0);
  };

  private _clearLongPressTimer = (): void => {
    if (this._longPressTimer !== null) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }
  };

  /** Long-press fired: select the word at `idx` and switch the active drag
   *  to word-granularity, so any subsequent finger drag extends by whole
   *  words (matching iOS / Android native text selection semantics). No
   *  navigator.vibrate here — Chrome / iOS already emit their own haptic
   *  during long-press detection (suppressed visually by pointerdown's
   *  preventDefault but the buzz fires before that takes effect, so a
   *  second vibration on top would be a double-tap. */
  private _promoteToWordSelection = (idx: number): void => {
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    const text = this.Text();
    const w = WordRangeAt(text, idx);
    this._dragGranularity = 'word';
    this._dragAnchor = w.start;
    this._focusHidden(input);
    input.setSelectionRange(w.start, w.end, 'forward');
    this.syncSelection();
    this._scrollCaretIntoView();
  };

  private _onDocPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this._dragPointerId) return;
    // Cancel the long-press timer once the finger has drifted past the
    // jitter threshold — the user is dragging, not pressing-and-holding.
    if (this._longPressTimer !== null) {
      const dx = e.clientX - this._pointerDownX;
      const dy = e.clientY - this._pointerDownY;
      if (Math.abs(dx) > Jinput._LongPressMovePx || Math.abs(dy) > Jinput._LongPressMovePx) {
        this._clearLongPressTimer();
      }
    }
    // SS-199: a plain single-finger touch drag must scroll, not select. Only
    // extend selection once the gesture has been promoted to word/line
    // granularity (long-press, or double/triple-tap), or when the user is
    // dragging an existing selection's end. Otherwise char-granularity touch
    // drags are inert here so the enclosing scroll container owns the gesture.
    if (this._dragIsTouch && this._dragGranularity === 'char' && !this._draggingSelectionEnd) return;
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
      const anchorRow = this._rowRangeAt(this._dragAnchor);
      const idxRow = this._rowRangeAt(idx);
      a = Math.min(anchorRow.start, idxRow.start);
      b = Math.max(anchorRow.end, idxRow.end);
    }
    const dir = idx >= this._dragAnchor ? 'forward' : 'backward';
    input.setSelectionRange(a, b, dir as 'forward' | 'backward' | 'none');
    this.syncSelection();
    this._scrollCaretIntoView();
  };

  private _onDocPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this._dragPointerId) return;
    this._dragPointerId = null;
    this._draggingSelectionEnd = false;
    this._clearLongPressTimer();
    document.removeEventListener('pointermove', this._onDocPointerMove);
    document.removeEventListener('pointerup', this._onDocPointerUp);
    document.removeEventListener('pointercancel', this._onDocPointerUp);
  };

  // ── Context menu ────────────────────────────────────────────────
  // Global pointer tracker — fires for every real mouse / touch move
  // anywhere on the page. We use this instead of an Angular `(pointermove)`
  // binding on the JinputRoot because Jaui's worker dispatches its
  // synthetic events on individual segment jext elements, and those
  // don't reliably bubble through the JinputRoot host (`display: contents`
  // host + Angular signal-input `[class]` aliasing leaves the bubbled
  // path inconsistent). Window listener has 100% coverage: we resolve to
  // canvas-local coords ourselves and emit PositionHovered with either
  // the resolved char index OR `null` when the pointer is outside the
  // text wrap. Tracking the previous "inside" state so we only emit on
  // transitions / changes — keeps the bridge traffic flat under typical
  // 60Hz mouse motion.
  private _lastHoverIndex: number | null | undefined = undefined;
  private _onWindowHoverMove = (e: PointerEvent): void => {
    const wrap = this._wrap();
    const canvasEl = this._jaui?.Canvas?.Element;
    if (!wrap || !canvasEl) return;
    const cRect = canvasEl.getBoundingClientRect();
    // Outside the canvas at all → not in editor → emit null once.
    if (e.clientX < cRect.left || e.clientX >= cRect.right ||
        e.clientY < cRect.top  || e.clientY >= cRect.bottom) {
      if (this._lastHoverIndex !== null) {
        this._lastHoverIndex = null;
        this.PositionHovered.emit({ index: null });
      }
      if (this._hoveredPeerKey() !== null) this._hoveredPeerKey.set(null);
      return;
    }
    const localX = e.clientX - cRect.left;
    const localY = e.clientY - cRect.top;
    const wx = wrap.Node.X, wy = wrap.Node.Y;
    const ww = wrap.Node.Width, wh = wrap.Node.Height;
    const inWrap = localX >= wx && localX < wx + ww && localY >= wy && localY < wy + wh;
    if (!inWrap) {
      if (this._lastHoverIndex !== null) {
        this._lastHoverIndex = null;
        this.PositionHovered.emit({ index: null });
      }
      if (this._hoveredPeerKey() !== null) this._hoveredPeerKey.set(null);
      return;
    }
    const idx = this._indexAtClient(e.clientX, e.clientY);
    if (idx !== this._lastHoverIndex) {
      this._lastHoverIndex = idx;
      this.PositionHovered.emit({ index: idx });
    }
    this._updateHoveredPeer(idx);
  };

  /** Match a hover index against every peer's selection range or caret.
   *  Mouse hover events don't fire per-jiv on Jaui (`display:contents`
   *  hosts → no Angular target), so we drive the peer hover signal
   *  entirely from the char-index resolved upstream. Collapsed carets
   *  get a ±2-char forgiveness window so a 2px line is actually
   *  catchable; range selections match strictly inside [start, end). */
  private _updateHoveredPeer = (idx: number | null): void => {
    if (idx === null) {
      if (this._hoveredPeerKey() !== null) this._hoveredPeerKey.set(null);
      return;
    }
    let next: string | null = null;
    for (const p of this.PeerCarets()) {
      const lo = Math.min(p.Start, p.End);
      const hi = Math.max(p.Start, p.End);
      const isRange = lo !== hi;
      if (isRange) {
        if (idx >= lo && idx < hi) { next = p.Key; break; }
      } else {
        if (idx >= lo - 2 && idx <= lo + 2) { next = p.Key; break; }
      }
    }
    if (next !== this._hoveredPeerKey()) this._hoveredPeerKey.set(next);
  };

  onRootContextMenu = (e: MouseEvent): void => {
    if (this.ReadOnly()) return;
    const input = this._hiddenInput()?.nativeElement;
    if (!input) return;
    // The original DOM contextmenu is already suppressed by Jaui Core's
    // canvas-level listener (it preventDefaults unconditionally). The
    // event arriving here is a synthetic clone; preventDefault on it has
    // no effect on the browser's native menu — so we just pass through
    // to the consumer.
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
    const rect = CharPosition(this.LaidOutSegments(), this._selEnd(), this._Metrics(), this._measureWidth);
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

  // ── Visual-row caret navigation (ArrowUp / ArrowDown) ──────────
  // Returns true if the caret moved (so the caller preventDefaults). When
  // there's no row to move into (already on top row going up, or last row
  // going down), returns false so the native input keeps its no-op behavior.
  private _moveCaretByVisualRow(delta: -1 | 1, shiftExtend: boolean): boolean {
    const laid = this.LaidOutSegments();
    if (laid.length === 0) return false;
    const lastRow = laid[laid.length - 1].Row;
    if (lastRow === 0) return false;
    const el = this._hiddenInput()?.nativeElement;
    if (!el) return false;

    const metrics = this._Metrics();
    const isBackward = el.selectionDirection === 'backward';
    const activeIdx = shiftExtend
      ? (isBackward ? this._selStart() : this._selEnd())
      : (delta === -1 ? this._selStart() : this._selEnd());
    const cur = CharPosition(laid, activeIdx, metrics, this._measureWidth);
    // Resolve cur's Row by finding the laid segment whose Y matches —
    // Y is no longer a simple row-pitch multiple (paragraph-break rows
    // are spaced by LineHeight only, soft-wrap rows by LineHeight +
    // RowGap), so we can't divide.
    let curRow = 0;
    for (const item of laid) {
      if (item.Y === cur.y) { curRow = item.Row; break; }
    }
    const targetRow = curRow + delta;
    if (targetRow < 0 || targetRow > lastRow) return false;

    // Find the actual Y of the target row from the laid output.
    let targetY = 0;
    for (const item of laid) {
      if (item.Row === targetRow) { targetY = item.Y + item.Height / 2; break; }
    }
    const targetIdx = IndexAtPoint(laid, cur.x, targetY, metrics, this._measureWidth);

    if (shiftExtend) {
      const anchor = isBackward ? this._selEnd() : this._selStart();
      const a = Math.min(anchor, targetIdx);
      const b = Math.max(anchor, targetIdx);
      const dir: 'forward' | 'backward' = targetIdx >= anchor ? 'forward' : 'backward';
      el.setSelectionRange(a, b, dir);
    } else {
      el.setSelectionRange(targetIdx, targetIdx);
    }
    this.syncSelection();
    this._scrollCaretIntoView();
    return true;
  }

  // ── Row-range helper for triple-click / line-drag ──────────────
  // Visual-row-aware "select this line" range. Picks the row containing the
  // segment that owns idx, then bounds by first/last segment on that row.
  // Falls back to whole-text when idx is past the end on an empty trailing
  // row, and to [0, 0] for empty input.
  private _rowRangeAt(idx: number): { start: number; end: number } {
    const laid = this.LaidOutSegments();
    const text = this.Text();
    if (laid.length === 0) return { start: 0, end: text.length };
    let row = laid[laid.length - 1].Row;
    for (const item of laid) {
      if (idx >= item.Seg.StartIndex && idx <= item.Seg.EndIndex) {
        row = item.Row;
        break;
      }
    }
    const onRow = laid.filter(s => s.Row === row);
    if (onRow.length === 0) return { start: 0, end: text.length };
    return {
      start: onRow[0].Seg.StartIndex,
      end: onRow[onRow.length - 1].Seg.EndIndex,
    };
  }

  // ── Hit-testing ─────────────────────────────────────────────────
  private _indexAtClient(clientX: number, clientY: number): number | null {
    const w = this._wrap();
    const canvasEl = this._jaui?.Canvas?.Element;
    if (!w || !canvasEl) return null;
    const cRect = canvasEl.getBoundingClientRect();
    const localX = clientX - cRect.left - w.Node.X;
    const localY = clientY - cRect.top - w.Node.Y;
    return IndexAtPoint(this.LaidOutSegments(), localX, localY, this._Metrics(), this._measureWidth);
  }

  // ── Native input bridge ─────────────────────────────────────────
  // Composition tracking — preserved for CJK IME edge cases that might
  // need it later, but `onInput` no longer gates on it. On Android Chrome
  // (and most other mobile soft keyboards) regular English typing fires
  // compositionstart/end pairs around every word as part of autocomplete
  // and prediction, which meant Text.set never fired per-keystroke and
  // the user saw nothing on screen until they tapped away to dismiss
  // composition. Forwarding every input event accepts the small flicker
  // risk on CJK input in exchange for live feedback everywhere else.
  private _composing = false;

  onInput = (event: Event): void => {
    const target = event.target as HTMLTextAreaElement;
    let value = target.value;
    if (!this.MultiLine() && /[\n\r]/.test(value)) {
      // Single-line surfaces strip pasted newlines (mirrors browser
      // behavior on <input type="text">). Write back to the textarea so
      // selectionStart / End remain meaningful.
      const cleaned = value.replace(/[\n\r]+/g, '');
      target.value = cleaned;
      const newPos = Math.min(target.selectionStart ?? cleaned.length, cleaned.length);
      target.setSelectionRange(newPos, newPos);
      value = cleaned;
    }
    this.Text.set(value);
    this.syncSelection();
  };

  onCompositionStart = (): void => {
    this._composing = true;
  };

  onCompositionEnd = (): void => {
    this._composing = false;
    const el = this._hiddenInput()?.nativeElement;
    if (!el) return;
    this.Text.set(el.value);
    this.syncSelection();
  };

  onKeyDown = (e: KeyboardEvent): void => {
    // Cmd/Ctrl + Enter is universal submit on every surface, even MultiLine.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.Submitted.emit(e);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!this.MultiLine()) {
        // Single-line surfaces: Enter commits, never inserts a newline.
        e.preventDefault();
        this.Submitted.emit(e);
        return;
      }
      // MultiLine: let the textarea insert \n natively; do not preventDefault
      // and do not emit Submitted (consumers use Cmd+Enter or Shift+Enter for
      // alternate submit semantics).
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      this.Cancelled.emit(e);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (this._moveCaretByVisualRow(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey)) {
        e.preventDefault();
        return;
      }
    }
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

  // ── Peer caret hover ─────────────────────────────────────────────
  // Tracks which peer's caret/selection the user is currently hovering
  // — drives the per-peer name pill's Opacity binding. Driven from
  // `_updateHoveredPeer` (char-index → peer Start/End match) because
  // Angular host events (pointerenter/leave) never fire on Jaui jivs
  // (their host elements are `display:contents` — nothing for the DOM
  // listener to attach to).
  protected readonly _hoveredPeerKey = signal<string | null>(null);

  syncSelection = (): void => {
    const el = this._hiddenInput()?.nativeElement;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    this._selStart.set(start);
    this._selEnd.set(end);
    this._caretBright.set(true);
    this._restartBlink();
    // Always emit — caller may be focus/blur where indices didn't move
    // but listeners need to know the selection is "live" again so they
    // can republish over collaboration channels (e.g. Yjs awareness).
    this.SelectionChanged.emit({ start, end });
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
