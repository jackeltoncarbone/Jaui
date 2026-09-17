import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import type { ResolvedSemantics } from './Seo.Types';

/** Tags whose mirror element CONTAINS descendants' mirror nodes. A card cell's
 *  `<a>` must wrap its title's `<h3>` — the hosts are display:contents, so
 *  containment can't come from DOM nesting of mirror nodes in place; the
 *  mirror tree is built here instead. */
const ContainerTags = new Set(['a', 'button', 'nav', 'main', 'section', 'ul', 'li']);

/** `Node.DOCUMENT_POSITION_PRECEDING`, named rather than read off the global: the mirror
 *  builds under server rendering too, where which DOM globals exist is the platform's business. */
const POSITION_PRECEDING = 2;

/** The accessible-clip pattern — visually hidden but still crawled and still read aloud.
 *  Deliberately NOT `display:none` / `aria-hidden`, either of which would take the mirror
 *  out of the very two trees it exists to be in. */
const MIRROR_ROOT_STYLE =
  'position:absolute;width:1px;height:1px;margin:-1px;padding:0;border:0;' +
  'overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;' +
  'z-index:0;pointer-events:none;user-select:none;-webkit-user-select:none';

export interface MirrorEntry {
  Host: HTMLElement;
  Parent: MirrorEntry | null;
  El: HTMLElement | null;
  Tag: string | null;
  TextNode: Text | null;
  Navigate: ((url: string) => void) | null;
}

/**
 * The semantic mirror — a painted DOM underlay beneath the Jaui canvas.
 * Crawlers index it, screen readers read it, and because it paints during
 * boot (before the canvas's first WebGPU frame) it is the page's first
 * contentful paint — which is what unlocks Lighthouse for canvas UIs.
 *
 * One instance per `<jaui>`. Jivs register an entry parented to their parent
 * Jiv's entry; `Apply` renders/updates the entry's element; placement +
 * document-order sorting happen on a microtask flush so `@if`/`@for` late
 * mounts land in authored order (same compareDocumentPosition trick as
 * `Jiv._reorderToDomPosition`).
 */
@Injectable()
export class SemanticMirror {
  /** The document is INJECTED, never the global. Under server rendering there is no global
   *  `document` — reading it is what made the whole canvas host throw before the mirror could
   *  paint a single node — while `inject(DOCUMENT)` resolves on both platforms. */
  private readonly _doc = inject(DOCUMENT);
  private _root: HTMLElement | null = null;
  private readonly _entries = new Set<MirrorEntry>();
  private _flushQueued = false;

  /** Create the mirror root inside the `<jaui>` host, before the canvas.
   *  Inline styles only — component style encapsulation can't reach
   *  runtime-created nodes. Visually hidden via the standard accessible-clip
   *  pattern (NOT display:none / aria-hidden) so it stays in the accessibility
   *  tree and is crawled, while a sighted user only ever sees the canvas — no
   *  pre-first-frame flash of unpositioned mirror text. */
  Attach = (host: HTMLElement, beforeEl: Element | null): void => {
    if (this._root) return;
    // HYDRATION: the server already painted a mirror into this very host, and the client is
    // reusing those nodes. Creating a second root here would leave the page carrying the
    // server's tree AND a live one — two copies of every heading and link in the accessibility
    // tree, and a crawler reading each twice. Adopt the one that is already there instead.
    // Its children are dropped because every entry re-registers and re-applies during this
    // boot; keeping them would strand the server's nodes under a root that no entry owns.
    const adopted = host.querySelector<HTMLElement>(':scope > div.JauiSemantics');
    if (adopted) {
      adopted.replaceChildren();
      this._root = adopted;
      return;
    }
    const root = this._doc.createElement('div');
    root.className = 'JauiSemantics';
    root.setAttribute('style', MIRROR_ROOT_STYLE);
    host.insertBefore(root, beforeEl);
    this._root = root;
  };

  Register = (host: HTMLElement, parent: MirrorEntry | null): MirrorEntry => {
    const entry: MirrorEntry = {
      Host: host, Parent: parent, El: null, Tag: null, TextNode: null, Navigate: null,
    };
    this._entries.add(entry);
    return entry;
  };

  Apply = (entry: MirrorEntry, resolved: ResolvedSemantics | null, navigate: ((url: string) => void) | null): void => {
    if (!resolved) {
      this._drop(entry);
      return;
    }
    entry.Navigate = navigate;
    if (entry.Tag !== resolved.Tag) {
      const el = this._doc.createElement(resolved.Tag);
      // Out of flow: late-arriving mirror nodes must not shift earlier ones
      // (CLS is measured on the painted underlay). Text still paints for
      // FCP. The positional-sync milestone replaces 0,0 with the node's
      // real layout rect via the watch-rect bridge channel.
      el.style.position = 'absolute';
      el.style.left = '0';
      el.style.top = '0';
      el.style.margin = '0';
      // Re-home any child mirror nodes the old element contained.
      if (entry.El) {
        while (entry.El.firstChild) el.appendChild(entry.El.firstChild);
        entry.El.remove();
      }
      entry.El = el;
      entry.Tag = resolved.Tag;
      if (resolved.TabIndex !== null) el.tabIndex = resolved.TabIndex;
      el.addEventListener('click', (e) => {
        const href = el.getAttribute('href');
        if (!href) return;
        e.preventDefault();
        entry.Navigate?.(href);
      });
    }
    const el = entry.El!;
    this._setAttr(el, 'href', resolved.Href);
    this._setAttr(el, 'src', resolved.Src);
    this._setAttr(el, 'alt', resolved.Alt);
    this._setAttr(el, 'aria-label', resolved.Label);
    // No loading=lazy: a lazy LCP image is a Lighthouse anti-pattern, and on
    // prerendered routes the bytes are already in the HTTP cache anyway.
    if (resolved.Tag === 'img') this._setAttr(el, 'decoding', 'async');
    // Text rides a dedicated first text node — containers gain child mirror
    // elements after it, and textContent assignment would wipe them.
    if (resolved.Text !== null) {
      if (!entry.TextNode || entry.TextNode.parentNode !== el) {
        entry.TextNode = this._doc.createTextNode('');
        el.insertBefore(entry.TextNode, el.firstChild);
      }
      if (entry.TextNode.data !== resolved.Text) entry.TextNode.data = resolved.Text;
    } else if (entry.TextNode) {
      entry.TextNode.remove();
      entry.TextNode = null;
    }
    this._queueFlush();
  };

  Unregister = (entry: MirrorEntry): void => {
    this._entries.delete(entry);
    this._drop(entry);
  };

  Serialize = (): string => this._root?.innerHTML ?? '';

  private _drop = (entry: MirrorEntry): void => {
    if (!entry.El) return;
    // Children inside this element belong to other entries; the flush
    // re-appends every live entry's element, so they re-home automatically.
    entry.El.remove();
    entry.El = null;
    entry.Tag = null;
    entry.TextNode = null;
    this._queueFlush();
  };

  private _setAttr = (el: HTMLElement, name: string, value: string | null): void => {
    if (value === null) el.removeAttribute(name);
    else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  };

  private _containerOf = (entry: MirrorEntry): HTMLElement => {
    let p = entry.Parent;
    while (p) {
      if (p.El && p.Tag && ContainerTags.has(p.Tag) && this._entries.has(p)) return p.El;
      p = p.Parent;
    }
    return this._root!;
  };

  private _queueFlush = (): void => {
    if (this._flushQueued || !this._root) return;
    this._flushQueued = true;
    queueMicrotask(() => {
      this._flushQueued = false;
      this._flush();
    });
  };

  /** Place every live element inside its nearest container ancestor, sorted
   *  by owner-host document order. appendChild moves nodes, so each flush is
   *  also self-healing after drops and re-parents. */
  private _flush = (): void => {
    if (!this._root) return;
    const groups = new Map<HTMLElement, MirrorEntry[]>();
    for (const entry of this._entries) {
      if (!entry.El || !entry.Host.isConnected) continue;
      const container = this._containerOf(entry);
      const list = groups.get(container);
      if (list) list.push(entry);
      else groups.set(container, [entry]);
    }
    for (const [container, list] of groups) {
      list.sort((a, b) => {
        if (a.Host === b.Host) return 0;
        return (a.Host.compareDocumentPosition(b.Host) & POSITION_PRECEDING) ? 1 : -1;
      });
      for (const entry of list) container.appendChild(entry.El!);
    }
  };
}
