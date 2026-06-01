// Core primitives only. Everything else lives in its feature slice.

export interface Vec2 {
  X: number;
  Y: number;
}

export interface Vec4 {
  X: number;
  Y: number;
  Z: number;
  W: number;
}

export interface Rect {
  X: number;
  Y: number;
  Width: number;
  Height: number;
}

export interface Color {
  R: number;
  G: number;
  B: number;
  A: number;
}

export const DefaultColor: Color = { R: 0, G: 0, B: 0, A: 0 };
export const White: Color = { R: 1, G: 1, B: 1, A: 1 };
export const Black: Color = { R: 0, G: 0, B: 0, A: 1 };

export type DeviceTier = 'Low' | 'Mid' | 'High';

export const DirtyFlag = {
  Layout:    0b00000001,
  Style:     0b00000010,
  Transform: 0b00000100,
  Children:  0b00001000,
  Visible:   0b00010000,
  Animating: 0b00100000,
  Clip:      0b01000000,
  Text:      0b10000000,
} as const;

export type DirtyFlags = number;
