export interface ScrollConfig {
  ScrollX: number;
  ScrollY: number;
  Stiffness: number;
  Damping: number;
}

export const DefaultScrollConfig: ScrollConfig = {
  ScrollX: 0,
  ScrollY: 0,
  Stiffness: 120,
  Damping: 20,
};
