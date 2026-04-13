/**
 * Pure math utilities. Static, no state, no DI.
 * Named after Show Studio's Jath (analogous to System.Math).
 */
export class Jath {

  static Lerp = (a: number, b: number, t: number): number =>
    a + (b - a) * t;

  static Clamp = (v: number, min: number, max: number): number =>
    Math.max(min, Math.min(max, v));

  static Remap = (v: number, inMin: number, inMax: number, outMin: number, outMax: number): number =>
    outMin + ((v - inMin) / (inMax - inMin)) * (outMax - outMin);

  static SmoothStep = (t: number): number => {
    t = Jath.Clamp(t, 0, 1);
    return t * t * (3 - 2 * t);
  };

  static InverseSmoothStep = (t: number): number => {
    t = Jath.Clamp(t, 0, 1);
    return 0.5 - Math.sin(Math.asin(1 - 2 * t) / 3);
  };

  /**
   * Superellipse signed distance field.
   * Negative = inside, positive = outside.
   * Folds into first quadrant for seamless corners.
   */
  static SuperellipseSDF = (
    px: number,
    py: number,
    halfW: number,
    halfH: number,
    radius: number,
    smoothness: number,
  ): number => {
    const n = 2 + 3 * smoothness;
    const qx = Math.max(Math.abs(px) - (halfW - radius), 0);
    const qy = Math.max(Math.abs(py) - (halfH - radius), 0);

    if (qx <= 0 && qy <= 0) {
      // Inside flat region — distance to nearest edge
      const dx = halfW - Math.abs(px);
      const dy = halfH - Math.abs(py);
      return -Math.min(dx, dy);
    }

    const dist = Math.pow(Math.pow(qx, n) + Math.pow(qy, n), 1 / n);
    return dist - radius;
  };

  /**
   * Superellipse SDF with per-corner radius.
   * radii: [topLeft, topRight, bottomRight, bottomLeft]
   */
  static SuperellipseSDFPerCorner = (
    px: number,
    py: number,
    halfW: number,
    halfH: number,
    radii: [number, number, number, number],
    smoothness: number,
  ): number => {
    // Select corner radius based on quadrant
    const r = px >= 0
      ? (py <= 0 ? radii[1] : radii[2])  // right: top-right or bottom-right
      : (py <= 0 ? radii[0] : radii[3]); // left:  top-left or bottom-left

    return Jath.SuperellipseSDF(px, py, halfW, halfH, r, smoothness);
  };

  /** EaseOutCubic — fast start, smooth decelerate. */
  static EaseOutCubic = (t: number): number => {
    t = 1 - t;
    return 1 - t * t * t;
  };

  /** EaseInOutCubic */
  static EaseInOutCubic = (t: number): number =>
    t < 0.5
      ? 4 * t * t * t
      : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /** Convert degrees to radians. */
  static Rad = (deg: number): number => deg * (Math.PI / 180);

  /** Convert radians to degrees. */
  static Deg = (rad: number): number => rad * (180 / Math.PI);

  /** Convert CSS corner shape name to superellipse exponent. */
  static CornerShapeExponent = (shape: string | number): number => {
    if (typeof shape === 'number') return shape;
    switch (shape) {
      case 'Round':    return 2;
      case 'Squircle': return 4;
      case 'Bevel':    return 1;
      case 'Scoop':    return -2;
      case 'Notch':    return 100;
      default:         return 2;
    }
  };
}
