// FontVariantNumeric: TabularNums, Apple's monospaced digits, through a tnum twin family (Text/Text.Tabular.ts).
import { describe, it, expect } from 'vitest';
import { RangeCoversDigits, TabularFamilyStack } from '@jaui/Text/Text.Tabular';
import { DefaultTextStyle, ResolveTextStyle } from '@jaui/Text/Text.Types';
import { SEED_CONTEXT } from '@jaui/Core/Style.Resolver';

describe('tabular figures', () => {
  it('put each named family behind its twin, and leave generics alone', () => {
    expect(TabularFamilyStack('Inter')).toBe('"Inter JauiTnum", Inter');
    expect(TabularFamilyStack('Inter, sans-serif')).toBe('"Inter JauiTnum", Inter, sans-serif');
    expect(TabularFamilyStack('"SF Pro", system-ui')).toBe('"SF Pro JauiTnum", "SF Pro", system-ui');
  });

  it('twin only the faces that hold the digits', () => {
    expect(RangeCoversDigits(undefined)).toBe(true);
    expect(RangeCoversDigits('U+0000-00FF, U+0131, U+0152-0153')).toBe(true);
    expect(RangeCoversDigits('U+0460-052F, U+1C80-1C8A')).toBe(false);
    expect(RangeCoversDigits('U+0030-0039')).toBe(true);
  });

  it('resolve into the family, so every cache keys on them, and throw on anything else', () => {
    const plain = ResolveTextStyle({ ...DefaultTextStyle, FontFamily: 'Inter' }, SEED_CONTEXT);
    const tabular = ResolveTextStyle({ ...DefaultTextStyle, FontFamily: 'Inter', FontVariantNumeric: 'TabularNums' }, SEED_CONTEXT);
    expect(plain.FontFamily).toBe('Inter');
    expect(tabular.FontFamily).toBe('"Inter JauiTnum", Inter');
    expect(() => ResolveTextStyle({ ...DefaultTextStyle, FontVariantNumeric: 'Tabular' as never }, SEED_CONTEXT)).toThrow(/FontVariantNumeric/);
  });
});
