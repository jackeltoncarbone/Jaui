/**
 * The screen's own corner radius, in points, for `@DisplayCornerRadius`.
 *
 * iOS reads it from the device (`UITraitCollection.displayCornerRadius`), which a web page cannot. A native shell
 * that can passes it in as the root custom property `--DisplayCornerRadius`; otherwise it is Apple's value for the
 * device class, looked up by the screen's size in points. Anything else is a window, and takes macOS 26's corner.
 */
export function DisplayCornerRadius(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  const native = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--DisplayCornerRadius'));
  if (Number.isFinite(native) && native >= 0) return native;
  const narrow = Math.min(window.screen.width, window.screen.height);
  const tall = Math.max(window.screen.width, window.screen.height);
  return DisplayCornerForScreen(narrow, tall);
}

/** Apple's display corner per device class, keyed by the portrait screen in points [I]: `_displayCornerRadius` as
 *  read off each device. Where two phones share a size and differ, the newer one's value is used. */
const DISPLAY_CORNERS: ReadonlyArray<readonly [narrow: number, tall: number, radius: number]> = [
  [375, 812, 44],     // iPhone 12 mini, 13 mini (X, XS, 11 Pro: 39)
  [414, 896, 41.5],   // iPhone XR, 11 (XS Max, 11 Pro Max: 39)
  [390, 844, 47.33],  // iPhone 12, 12 Pro, 13, 13 Pro, 14
  [428, 926, 53.33],  // iPhone 12 Pro Max, 13 Pro Max, 14 Plus
  [393, 852, 55],     // iPhone 14 Pro, 15, 15 Pro, 16
  [430, 932, 55],     // iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  [402, 874, 62],     // iPhone 16 Pro, 17, 17 Pro
  [420, 912, 62],     // iPhone Air
  [440, 956, 62],     // iPhone 16 Pro Max, 17 Pro Max
  [744, 1133, 18],    // iPad mini
  [820, 1180, 18],    // iPad Air, iPad
  [834, 1194, 18],    // iPad Pro 11
  [834, 1210, 18],    // iPad Pro 11 (M4)
  [1024, 1366, 18],   // iPad Pro 12.9
  [1032, 1376, 18],   // iPad Pro 13 (M4)
];

/** A macOS 26 window with a unified toolbar: `-[NSThemeFrame _getCachedWindowCornerRadius]` returns 26 for it (20
 *  unified compact, 16 expanded or no toolbar, 15 utility, 26 sheet and alert) [C] (Jwift/Apple/Sizing.md). */
export const WINDOW_CORNER_RADIUS = 26;

export function DisplayCornerForScreen(narrow: number, tall: number): number {
  for (const [w, h, radius] of DISPLAY_CORNERS) if (w === narrow && h === tall) return radius;
  return WINDOW_CORNER_RADIUS;
}
