/** A dev-only snapshot of the laid-out tree: what a layout checker reads instead of pixels. */

export interface ProbeRect {
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

export interface ProbeText {
  /** First 60 characters. */
  Content: string;
  /** Unbounded single-line width and the longest word, in CSS px. */
  MaxContentWidth: number;
  MinContentWidth: number;
  /** Re-measured at the node's content-box width: what the renderer wraps to. */
  WrappedHeight: number;
  WrappedLines: number;
  FontSize: number;
  LineHeight: number;
  TextOverflow: 'Clip' | 'Ellipsis';
  MaxLines: number | null;
}

export interface ProbeNode {
  /** Worker registry id (matches `data-jiv` on the Angular host in dev); -1 when unregistered, 0 = root. */
  Id: number;
  Classes: string[];
  /** Filled on the main thread from the Angular host element. */
  Tag?: string;
  Host?: string;
  Listeners?: string[];
  Href?: string;
  /** Screen rect: canvas-absolute, ancestor scroll applied, render plane. */
  Rect: ProbeRect;
  /** Rect relative to the parent's box. */
  Local: ProbeRect;
  /** Screen rect intersected with every ancestor clip (not the viewport); null when fully clipped away. */
  VisibleRect: ProbeRect | null;
  /** True when the render plane has not yet reached the layout target (a spring is still flying). */
  Moving: boolean;
  Padding: [number, number, number, number];
  Margin: [number, number, number, number];
  Layout: { Mode: string; Direction: string; Wrap: string; Align: string; AlignContent: string; Justify: string; Gap: number };
  AlignSelf: string;
  Width: string;
  Height: string;
  Position: string;
  Overflow: string;
  Clip: string;
  ClipsChildren: boolean;
  ParentOverflow: string;
  Scroll: { X: number; Y: number; ContentWidth: number; ContentHeight: number } | null;
  Layer: number;
  ZIndex: number | 'Auto';
  /** The drawn corner radius, which carries the superellipse compensation. */
  Radius: number;
  /** The smallest corner as authored: what decides whether the shape saturates to a circle or pill. */
  RadiusAuthored: number;
  HasPaint: boolean;
  /** What the background paints: Color, Image, LinearGradient or RadialGradient; null for a non-jiv. */
  Background: string | null;
  Opacity: number;
  Presence: number;
  Visible: boolean;
  Interactive: boolean;
  Cursor: string;
  PointerEvents: string;
  Leaving: boolean;
  Text: ProbeText | null;
  Children: ProbeNode[];
}

export interface ProbeSnapshot {
  Viewport: { Width: number; Height: number; Dpr: number };
  /** No spring running and no node off its layout target. */
  Settled: boolean;
  Root: ProbeNode;
}
