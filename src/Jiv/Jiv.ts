import type { JivStyle } from './Jiv.Types';
import { DefaultJivStyle } from './Jiv.Defaults';
import type { LayoutConfig, ChildLayout } from '../Layout/Layout.Types';
import { DefaultLayoutConfig, DefaultChildLayout } from '../Layout/Layout.Types';
import { DirtyFlag, type DirtyFlags } from '../Core/Types';

export class Jiv {
  // Computed layout position (set by layout solver or manually)
  X: number = 0;
  Y: number = 0;
  Width: number = 0;
  Height: number = 0;

  // Tree
  Parent: Jiv | null = null;
  Children: Jiv[] = [];

  // Style — deep copy so mutations are local
  Style: JivStyle;

  // Layout — container config (how this node lays out its children)
  Layout: LayoutConfig;

  // Layout — child config (how this node behaves as a child of its parent)
  ChildLayout: ChildLayout;

  // Dirty tracking
  Dirty: DirtyFlags = DirtyFlag.Layout;

  constructor(options?: {
    X?: number;
    Y?: number;
    Width?: number;
    Height?: number;
    Style?: Partial<JivStyle>;
    Layout?: Partial<LayoutConfig>;
    ChildLayout?: Partial<ChildLayout>;
  }) {
    this.X = options?.X ?? 0;
    this.Y = options?.Y ?? 0;
    this.Width = options?.Width ?? 0;
    this.Height = options?.Height ?? 0;
    this.Style = { ...DefaultJivStyle, ...options?.Style };

    // Deep copy nested objects
    if (!options?.Style?.Transform) {
      this.Style.Transform = { ...DefaultJivStyle.Transform };
    }
    this.Style.BorderRadius = options?.Style?.BorderRadius
      ? [...options.Style.BorderRadius]
      : [...DefaultJivStyle.BorderRadius];
    this.Style.CornerShape = options?.Style?.CornerShape
      ? [...options.Style.CornerShape]
      : [...DefaultJivStyle.CornerShape];

    // Layout config — deep copy Padding tuple
    this.Layout = { ...DefaultLayoutConfig, ...options?.Layout };
    this.Layout.Padding = options?.Layout?.Padding
      ? [...options.Layout.Padding]
      : [...DefaultLayoutConfig.Padding];

    // Child layout — deep copy Margin tuple
    this.ChildLayout = { ...DefaultChildLayout, ...options?.ChildLayout };
    this.ChildLayout.Margin = options?.ChildLayout?.Margin
      ? [...options.ChildLayout.Margin]
      : [...DefaultChildLayout.Margin];
  }

  AddChild = (child: Jiv): void => {
    if (child.Parent) child.Parent.RemoveChild(child);
    child.Parent = this;
    this.Children.push(child);
    this.Dirty |= DirtyFlag.Layout | DirtyFlag.Children;
  };

  RemoveChild = (child: Jiv): void => {
    const idx = this.Children.indexOf(child);
    if (idx >= 0) {
      this.Children.splice(idx, 1);
      child.Parent = null;
      this.Dirty |= DirtyFlag.Layout | DirtyFlag.Children;
    }
  };

  MarkLayoutDirty = (): void => {
    this.Dirty |= DirtyFlag.Layout;
    if (this.Parent) this.Parent.Dirty |= DirtyFlag.Layout;
  };
}
