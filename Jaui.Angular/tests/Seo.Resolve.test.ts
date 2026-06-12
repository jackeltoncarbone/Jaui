import { describe, expect, it } from 'vitest';
import { ExtractBackgroundUrl, ResolveSemantics } from '../src/Seo/Seo.Resolve';
import { ParseJss } from '../../Jaui/src/Jss/Jss.Parser';

describe('ResolveSemantics', () => {
  it('projects nothing when undeclared (opt-in contract)', () => {
    expect(ResolveSemantics({ Text: 'Hello' })).toBeNull();
    expect(ResolveSemantics({})).toBeNull();
    expect(ResolveSemantics({ BackgroundUrl: 'x.png' })).toBeNull();
  });

  it('projects nothing for None, even with other declarations', () => {
    expect(ResolveSemantics({ Role: 'None', Text: 'Hello', Href: '/x' })).toBeNull();
  });

  it('template role wins over JSS style role', () => {
    const r = ResolveSemantics({ Role: 'Paragraph', StyleRole: 'Heading', Text: 'T' });
    expect(r?.Tag).toBe('p');
  });

  it('JSS style role applies when no template role', () => {
    const r = ResolveSemantics({ StyleRole: 'Heading', Text: 'T' });
    expect(r?.Tag).toBe('h2');
  });

  it('ignores unknown JSS role strings', () => {
    expect(ResolveSemantics({ StyleRole: 'Banana', Text: 'T' })).toBeNull();
  });

  it('heading level defaults to 2 and clamps to 1-6', () => {
    expect(ResolveSemantics({ Role: 'Heading' })?.Tag).toBe('h2');
    expect(ResolveSemantics({ Role: 'Heading', Level: 1 })?.Tag).toBe('h1');
    expect(ResolveSemantics({ Role: 'Heading', Level: 0 })?.Tag).toBe('h1');
    expect(ResolveSemantics({ Role: 'Heading', Level: 9 })?.Tag).toBe('h6');
  });

  it('JSS carries the level — Semantics: Heading 1 — with template level overriding', () => {
    expect(ResolveSemantics({ StyleRole: 'Heading 1', Text: 'T' })?.Tag).toBe('h1');
    expect(ResolveSemantics({ StyleRole: 'Heading 3', Text: 'T' })?.Tag).toBe('h3');
    expect(ResolveSemantics({ StyleRole: 'Heading', Text: 'T' })?.Tag).toBe('h2');
    expect(ResolveSemantics({ StyleRole: 'Heading 3', Level: 1, Text: 'T' })?.Tag).toBe('h1');
  });

  it('href implies Link when no role is declared', () => {
    const r = ResolveSemantics({ Href: '/store', Text: 'Store' });
    expect(r?.Tag).toBe('a');
    expect(r?.Href).toBe('/store');
    expect(r?.TabIndex).toBe(-1);
  });

  it('declared alt + image url implies Image', () => {
    const r = ResolveSemantics({ Alt: 'Cover', BackgroundUrl: 'https://x/y.png' });
    expect(r?.Tag).toBe('img');
    expect(r?.Src).toBe('https://x/y.png');
    expect(r?.Alt).toBe('Cover');
    expect(r?.Text).toBeNull();
  });

  it('maps container and text roles to their tags', () => {
    expect(ResolveSemantics({ Role: 'Navigation' })?.Tag).toBe('nav');
    expect(ResolveSemantics({ Role: 'Main' })?.Tag).toBe('main');
    expect(ResolveSemantics({ Role: 'Section' })?.Tag).toBe('section');
    expect(ResolveSemantics({ Role: 'List' })?.Tag).toBe('ul');
    expect(ResolveSemantics({ Role: 'ListItem' })?.Tag).toBe('li');
    expect(ResolveSemantics({ Role: 'Button', Text: 'Go' })?.Tag).toBe('button');
    expect(ResolveSemantics({ Role: 'Label', Text: 'New' })?.Tag).toBe('span');
  });

  it('carries label as aria-label payload', () => {
    expect(ResolveSemantics({ Role: 'Button', Label: 'Close' })?.Label).toBe('Close');
  });
});

describe('ExtractBackgroundUrl', () => {
  it('extracts the url from Url(...) backgrounds', () => {
    expect(ExtractBackgroundUrl('Url("https://x/y.png", Cover)')).toBe('https://x/y.png');
    expect(ExtractBackgroundUrl('Url("a.jpg", Cover, transparent)')).toBe('a.jpg');
  });

  it('returns null for non-image backgrounds', () => {
    expect(ExtractBackgroundUrl('#101014')).toBeNull();
    expect(ExtractBackgroundUrl(undefined)).toBeNull();
    expect(ExtractBackgroundUrl('transparent')).toBeNull();
  });
});

describe('JSS catch-all contract', () => {
  it('routes a Semantics declaration into the Style bag as a raw string', () => {
    const parsed = ParseJss('Title {\n  FontSize: 28\n  Semantics: Heading\n}');
    const style = parsed.Sheet['Title']?.Style as Record<string, unknown> | undefined;
    expect(style?.['Semantics']).toBe('Heading');
  });
});
