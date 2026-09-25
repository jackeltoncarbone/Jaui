/**
 * `FontVariantNumeric: TabularNums`, Apple's monospaced digits (SwiftUI `.monospacedDigit()`, UIFontDescriptor
 * `kNumberSpacingType` / `kMonospacedNumbersSelector`). A 2D canvas has no font-feature property, so every face that
 * covers the digits is installed a second time under a twin family with OpenType `tnum` on (the FontFace
 * `featureSettings` descriptor, honored by canvas text in Chromium workers), and tabular text names the twin first.
 * The twin rides in the font string, so every measurement and raster cache keys on it with no extra field.
 */

/** The feature a twin face is installed with. */
export const TABULAR_FEATURE_SETTINGS = '"tnum" 1';

/** The twin family of `family`: the same face with tabular figures. */
export const TabularFamilyName = (family: string): string => `${family} JauiTnum`;

const _GENERIC = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'emoji', 'math', 'fangsong',
  'ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont',
]);

const _stacks = new Map<string, string>();

/** A `FontFamily` stack with each named family preceded by its twin. A twin not installed (yet, or ever: a
 *  system face) falls through to the family itself, which is proportional figures, never a missing glyph. */
export const TabularFamilyStack = (stack: string): string => {
  const cached = _stacks.get(stack);
  if (cached !== undefined) return cached;
  const out: string[] = [];
  for (const raw of stack.split(',')) {
    const name = raw.trim().replace(/^["']|["']$/g, '');
    if (!name) continue;
    const quoted = /^["']/.test(raw.trim()) || /\s/.test(name) ? `"${name}"` : name;
    if (!_GENERIC.has(name.toLowerCase())) out.push(`"${TabularFamilyName(name)}"`);
    out.push(quoted);
  }
  const result = out.join(', ');
  _stacks.set(stack, result);
  return result;
};

/** Whether a face with this `unicode-range` holds the ASCII digits (no range: the whole font). */
export const RangeCoversDigits = (unicodeRange: string | undefined): boolean => {
  if (!unicodeRange) return true;
  for (const part of unicodeRange.split(',')) {
    const m = /^\s*U\+([0-9A-Fa-f?]+)(?:-([0-9A-Fa-f]+))?\s*$/.exec(part);
    if (!m) continue;
    const lo = parseInt(m[1].replace(/\?/g, '0'), 16);
    const hi = m[2] !== undefined ? parseInt(m[2], 16) : parseInt(m[1].replace(/\?/g, 'F'), 16);
    if (lo <= 0x30 && hi >= 0x39) return true;
  }
  return false;
};
