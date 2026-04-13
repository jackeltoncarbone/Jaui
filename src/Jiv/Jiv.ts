import type { JivStyle } from './Jiv.Types';
import { DefaultJivStyle } from './Jiv.Defaults';

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

  constructor(options?: {
    X?: number;
    Y?: number;
    Width?: number;
    Height?: number;
    Style?: Partial<JivStyle>;
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
  }

  AddChild = (child: Jiv): void => {
    if (child.Parent) child.Parent.RemoveChild(child);
    child.Parent = this;
    this.Children.push(child);
  };

  RemoveChild = (child: Jiv): void => {
    const idx = this.Children.indexOf(child);
    if (idx >= 0) {
      this.Children.splice(idx, 1);
      child.Parent = null;
    }
  };
}
