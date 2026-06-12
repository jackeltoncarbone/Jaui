import { beforeEach, describe, expect, it } from 'vitest';
import { SemanticMirror, type MirrorEntry } from '../src/Seo/Semantic.Mirror';
import type { ResolvedSemantics } from '../src/Seo/Seo.Types';

const Resolved = (partial: Partial<ResolvedSemantics> & { Tag: string }): ResolvedSemantics => ({
  Text: null, Href: null, Src: null, Alt: null, Label: null, TabIndex: null,
  ...partial,
});

const Flush = (): Promise<void> => new Promise((done) => queueMicrotask(() => queueMicrotask(done)));

describe('SemanticMirror', () => {
  let host: HTMLElement;
  let canvas: HTMLCanvasElement;
  let mirror: SemanticMirror;

  const MakeHost = (parent: HTMLElement): HTMLElement => {
    const el = document.createElement('jiv');
    parent.appendChild(el);
    return el;
  };

  beforeEach(() => {
    document.body.innerHTML = '';
    host = document.createElement('jaui');
    canvas = document.createElement('canvas');
    host.appendChild(canvas);
    document.body.appendChild(host);
    mirror = new SemanticMirror();
    mirror.Attach(host, canvas);
  });

  it('creates the underlay root before the canvas, not aria-hidden', () => {
    const root = host.querySelector('.JauiSemantics') as HTMLElement;
    expect(root).toBeTruthy();
    expect(root.nextElementSibling).toBe(canvas);
    expect(root.getAttribute('aria-hidden')).toBeNull();
    expect(root.style.zIndex).toBe('0');
    expect(root.style.pointerEvents).toBe('none');
  });

  it('projects text elements and updates text in place', async () => {
    const entry = mirror.Register(MakeHost(host), null);
    mirror.Apply(entry, Resolved({ Tag: 'h1', Text: 'Hello' }), null);
    await Flush();
    expect(host.querySelector('.JauiSemantics h1')?.textContent).toBe('Hello');
    mirror.Apply(entry, Resolved({ Tag: 'h1', Text: 'Updated' }), null);
    await Flush();
    expect(host.querySelector('.JauiSemantics h1')?.textContent).toBe('Updated');
  });

  it('keeps mirror nodes out of flow so late arrivals cause no layout shift', async () => {
    const entry = mirror.Register(MakeHost(host), null);
    mirror.Apply(entry, Resolved({ Tag: 'p', Text: 'Stable' }), null);
    await Flush();
    const el = host.querySelector('.JauiSemantics p') as HTMLElement;
    expect(el.style.position).toBe('absolute');
  });

  it('nests child mirror nodes inside the nearest container ancestor', async () => {
    const cellHost = MakeHost(host);
    const titleHost = MakeHost(cellHost);
    const cell = mirror.Register(cellHost, null);
    const title = mirror.Register(titleHost, cell);
    mirror.Apply(cell, Resolved({ Tag: 'a', Href: '/store/item/3', TabIndex: -1 }), null);
    mirror.Apply(title, Resolved({ Tag: 'h3', Text: 'Plume Set' }), null);
    await Flush();
    const anchor = host.querySelector('.JauiSemantics > a') as HTMLAnchorElement;
    expect(anchor).toBeTruthy();
    expect(anchor.getAttribute('href')).toBe('/store/item/3');
    expect(anchor.querySelector('h3')?.textContent).toBe('Plume Set');
    expect(anchor.tabIndex).toBe(-1);
  });

  it('does not nest into non-container parents', async () => {
    const pHost = MakeHost(host);
    const childHost = MakeHost(pHost);
    const p = mirror.Register(pHost, null);
    const child = mirror.Register(childHost, p);
    mirror.Apply(p, Resolved({ Tag: 'p', Text: 'Body' }), null);
    mirror.Apply(child, Resolved({ Tag: 'span', Text: 'Inline' }), null);
    await Flush();
    const root = host.querySelector('.JauiSemantics')!;
    expect(root.querySelector(':scope > p')).toBeTruthy();
    expect(root.querySelector(':scope > span')).toBeTruthy();
    expect(root.querySelector('p > span')).toBeNull();
  });

  it('orders mirror nodes by host document order, including late mounts', async () => {
    const hostA = MakeHost(host);
    const hostB = MakeHost(host);
    const b = mirror.Register(hostB, null);
    mirror.Apply(b, Resolved({ Tag: 'p', Text: 'Second' }), null);
    await Flush();
    // A mounts late (e.g. @if flipping true) but precedes B in the DOM.
    const a = mirror.Register(hostA, null);
    mirror.Apply(a, Resolved({ Tag: 'p', Text: 'First' }), null);
    await Flush();
    const texts = [...host.querySelectorAll('.JauiSemantics > p')].map((el) => el.textContent);
    expect(texts).toEqual(['First', 'Second']);
  });

  it('projects images with src, alt, and async decoding', async () => {
    const entry = mirror.Register(MakeHost(host), null);
    mirror.Apply(entry, Resolved({ Tag: 'img', Src: 'x.png', Alt: 'Cover art' }), null);
    await Flush();
    const img = host.querySelector('.JauiSemantics img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('x.png');
    expect(img.getAttribute('alt')).toBe('Cover art');
    expect(img.getAttribute('loading')).toBeNull();
    expect(img.getAttribute('decoding')).toBe('async');
  });

  it('navigates through the hook on anchor activation, preventing default', async () => {
    const entry = mirror.Register(MakeHost(host), null);
    let navigated: string | null = null;
    mirror.Apply(entry, Resolved({ Tag: 'a', Href: '/library', Text: 'Library', TabIndex: -1 }), (url) => { navigated = url; });
    await Flush();
    const anchor = host.querySelector('.JauiSemantics a') as HTMLAnchorElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(evt);
    expect(navigated).toBe('/library');
    expect(evt.defaultPrevented).toBe(true);
  });

  it('drops the node on Apply(null) — the seo-off path', async () => {
    const entry = mirror.Register(MakeHost(host), null);
    mirror.Apply(entry, Resolved({ Tag: 'p', Text: 'On' }), null);
    await Flush();
    expect(host.querySelector('.JauiSemantics p')?.textContent).toBe('On');
    mirror.Apply(entry, null, null);
    await Flush();
    expect(host.querySelector('.JauiSemantics p')).toBeNull();
  });

  it('re-homes children when a container unregisters', async () => {
    const cellHost = MakeHost(host);
    const titleHost = MakeHost(cellHost);
    const cell = mirror.Register(cellHost, null);
    const title = mirror.Register(titleHost, cell);
    mirror.Apply(cell, Resolved({ Tag: 'a', Href: '/x' }), null);
    mirror.Apply(title, Resolved({ Tag: 'h3', Text: 'Orphan' }), null);
    await Flush();
    mirror.Unregister(cell);
    mirror.Apply(title, Resolved({ Tag: 'h3', Text: 'Orphan' }), null);
    await Flush();
    const root = host.querySelector('.JauiSemantics')!;
    expect(root.querySelector('a')).toBeNull();
    expect(root.querySelector(':scope > h3')?.textContent).toBe('Orphan');
  });

  it('rebuilds the element on tag change, keeping nested children', async () => {
    const wrapHost = MakeHost(host);
    const childHost = MakeHost(wrapHost);
    const wrap = mirror.Register(wrapHost, null);
    const child = mirror.Register(childHost, wrap);
    mirror.Apply(wrap, Resolved({ Tag: 'section' }), null);
    mirror.Apply(child, Resolved({ Tag: 'p', Text: 'Kept' }), null);
    await Flush();
    mirror.Apply(wrap, Resolved({ Tag: 'nav' }), null);
    await Flush();
    const root = host.querySelector('.JauiSemantics')!;
    expect(root.querySelector('section')).toBeNull();
    expect(root.querySelector('nav > p')?.textContent).toBe('Kept');
  });
});
