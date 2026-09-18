/**
 * Worker.FontScan — the discovery half of the worker's font mirror.
 *
 * Canvas text is rasterised in the worker, so a face the scan fails to find is a face the engine
 * draws without. Nothing about that failure is visible from the page: the DOM is styled by the
 * browser and looks right, and the only symptom is that the canvas is in a fallback face. These
 * tests exist because that gap has no other alarm.
 */

import { describe, it, expect } from 'vitest';
import {
  FirstFontUrl,
  FontFaceFromDeclarations,
  ParseFontFacesFromCss,
  IsCrossOriginSheet,
  ShouldFetchSheetText,
} from '@jaui/Worker/Bridge.Main';

// Trimmed from what fonts.googleapis.com/css2?family=Inter:wght@400;500... actually returns.
const GOOGLE_CSS = `
/* cyrillic-ext */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/cyrillic-ext.woff2) format('woff2');
  unicode-range: U+0460-052F, U+1C80-1C88, U+20B4;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/latin.woff2) format('woff2');
  unicode-range: U+0000-00FF, U+0131;
}
/* latin */
@font-face {
  font-family: 'Inter';
  font-style: normal;
  font-weight: 700;
  font-display: swap;
  src: url(https://fonts.gstatic.com/s/inter/v20/latin-700.woff2) format('woff2');
  unicode-range: U+0000-00FF;
}
`;

const SHEET_URL = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap';
const PAGE_URL = 'https://show.studio/drill/abc';

describe('FirstFontUrl', () => {
  it('takes the first url() and drops the format() clause', () => {
    expect(FirstFontUrl("url(https://a.test/x.woff2) format('woff2')", PAGE_URL))
      .toBe('https://a.test/x.woff2');
  });

  it('accepts quoted urls', () => {
    expect(FirstFontUrl('url("https://a.test/x.woff2")', PAGE_URL)).toBe('https://a.test/x.woff2');
    expect(FirstFontUrl("url('https://a.test/x.woff2')", PAGE_URL)).toBe('https://a.test/x.woff2');
  });

  it('resolves a relative url against the SHEET, not the page', () => {
    expect(FirstFontUrl('url(../f/Inter.woff2)', 'https://cdn.test/css/site.css'))
      .toBe('https://cdn.test/f/Inter.woff2');
  });

  it('is null for a src with no url at all — local() only cannot be shipped to the worker', () => {
    expect(FirstFontUrl("local('Inter')", PAGE_URL)).toBeNull();
  });
});

describe('ParseFontFacesFromCss', () => {
  it('finds every face in the Google stylesheet with its descriptors', () => {
    const faces = ParseFontFacesFromCss(GOOGLE_CSS, SHEET_URL);
    expect(faces).toHaveLength(3);
    expect(faces.map(f => f.Family)).toEqual(['Inter', 'Inter', 'Inter']);
    expect(faces.map(f => f.Weight)).toEqual(['400', '400', '700']);
    expect(faces[1].Url).toBe('https://fonts.gstatic.com/s/inter/v20/latin.woff2');
    expect(faces[1].Style).toBe('normal');
    expect(faces[1].Display).toBe('swap');
    expect(faces[1].UnicodeRange).toBe('U+0000-00FF, U+0131');
  });

  it('strips the quotes off the family — the worker constructs FontFace with a bare name', () => {
    const faces = ParseFontFacesFromCss(`@font-face{font-family:"My Face";src:url(a.woff2)}`, PAGE_URL);
    expect(faces[0].Family).toBe('My Face');
  });

  it('reads a minified block, where the first declaration has no leading whitespace', () => {
    const faces = ParseFontFacesFromCss(
      `@font-face{font-family:'Inter';font-style:italic;font-weight:500;src:url(i.woff2)}`,
      'https://cdn.test/a.css',
    );
    expect(faces).toHaveLength(1);
    expect(faces[0].Style).toBe('italic');
    expect(faces[0].Weight).toBe('500');
    expect(faces[0].Url).toBe('https://cdn.test/i.woff2');
  });

  it('skips a block with no usable url instead of sending a face the worker cannot build', () => {
    expect(ParseFontFacesFromCss(`@font-face{font-family:'X';src:local('X')}`, PAGE_URL)).toEqual([]);
    expect(ParseFontFacesFromCss(`@font-face{src:url(a.woff2)}`, PAGE_URL)).toEqual([]);
  });

  it('finds nothing in CSS that carries no faces', () => {
    expect(ParseFontFacesFromCss('body { color: red }', PAGE_URL)).toEqual([]);
  });
});

describe('FontFaceFromDeclarations', () => {
  it('reads the same shape a CSSFontFaceRule presents', () => {
    const props: Record<string, string> = {
      'font-family': "'Inter'",
      'src': "url(/f/inter.woff2) format('woff2')",
      'font-weight': '600',
    };
    const face = FontFaceFromDeclarations((p) => props[p] || undefined, PAGE_URL);
    expect(face).not.toBeNull();
    expect(face!.Family).toBe('Inter');
    expect(face!.Url).toBe('https://show.studio/f/inter.woff2');
    expect(face!.Weight).toBe('600');
    expect(face!.Style).toBeUndefined();
  });
});

describe('IsCrossOriginSheet — which sheets need their text fetched', () => {
  it('is true for the Google Fonts stylesheet on the deployed page', () => {
    expect(IsCrossOriginSheet(SHEET_URL, PAGE_URL)).toBe(true);
  });

  it('is false for the app\'s own stylesheet', () => {
    expect(IsCrossOriginSheet('https://show.studio/styles-abc.css', PAGE_URL)).toBe(false);
    expect(IsCrossOriginSheet('/styles-abc.css', PAGE_URL)).toBe(false);
  });

  it('is false for an inline <style>, which has no href', () => {
    expect(IsCrossOriginSheet(null, PAGE_URL)).toBe(false);
    expect(IsCrossOriginSheet(undefined, PAGE_URL)).toBe(false);
    expect(IsCrossOriginSheet('', PAGE_URL)).toBe(false);
  });

  it('counts a different SCHEME or PORT as another origin', () => {
    expect(IsCrossOriginSheet('http://show.studio/a.css', PAGE_URL)).toBe(true);
    expect(IsCrossOriginSheet('https://show.studio:8443/a.css', PAGE_URL)).toBe(true);
  });
});

/**
 * The hole the lane was opened for.
 *
 * `walk()` used to fetch a stylesheet's text only when reading `.cssRules` threw or answered null.
 * Engines do not agree on how a cross-origin sheet refuses: Chromium throws, WebKit has answered
 * null, and an empty-but-present CSSRuleList is a third answer no test covered. Under that third
 * answer the old predicate said "readable, and it has no faces", the Google sheet was never
 * fetched, and the worker got no font at all — on that engine only.
 *
 * These call the predicate `walk()` itself calls. `rulesReadable` is false exactly when `.cssRules`
 * threw or answered null; true means a list came back, however long it was.
 */
describe('ShouldFetchSheetText', () => {
  it('fetches when a cross-origin sheet answers with an EMPTY rule list (the iOS-shaped case)', () => {
    expect(ShouldFetchSheetText(0, true, SHEET_URL, PAGE_URL)).toBe(true);
  });

  it('still fetches when the sheet refused — Chromium throws, WebKit has answered null', () => {
    expect(ShouldFetchSheetText(0, false, SHEET_URL, PAGE_URL)).toBe(true);
  });

  it('does not fetch a sheet whose rules already gave up its faces', () => {
    expect(ShouldFetchSheetText(3, true, SHEET_URL, PAGE_URL)).toBe(false);
  });

  it('does not fetch even a refusing sheet once its rules yielded a face', () => {
    expect(ShouldFetchSheetText(1, false, SHEET_URL, PAGE_URL)).toBe(false);
  });

  it('does not re-fetch the app\'s own readable stylesheet just because it carries no faces', () => {
    expect(ShouldFetchSheetText(0, true, 'https://show.studio/styles-abc.css', PAGE_URL)).toBe(false);
  });

  it('does fetch the app\'s own sheet if it somehow refused to be read', () => {
    expect(ShouldFetchSheetText(0, false, 'https://show.studio/styles-abc.css', PAGE_URL)).toBe(true);
  });

  it('does not fetch an inline <style>, which has no url to fetch', () => {
    expect(ShouldFetchSheetText(0, false, null, PAGE_URL)).toBe(false);
    expect(ShouldFetchSheetText(0, true, undefined, PAGE_URL)).toBe(false);
  });
});
