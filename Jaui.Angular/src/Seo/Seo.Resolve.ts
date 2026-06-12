import type { ResolvedSemantics, SemanticRole } from './Seo.Types';

/** Everything a Jiv knows about itself that can drive projection. */
export interface SemanticsSource {
  /** Template `semantics` input — highest precedence. */
  Role?: SemanticRole;
  /** Heading level (template `level` input). Default 2, clamped 1–6. */
  Level?: number;
  /** JSS `Semantics:` value from the resolved style class (raw string). */
  StyleRole?: string;
  Href?: string | null;
  Alt?: string | null;
  Label?: string | null;
  Text?: string | null;
  /** Image URL extracted from the resolved Background style. */
  BackgroundUrl?: string | null;
}

const Roles = new Set<string>([
  'None', 'Heading', 'Paragraph', 'Label', 'Link', 'Button', 'Image',
  'List', 'ListItem', 'Navigation', 'Main', 'Section',
]);

const Tags: Record<Exclude<SemanticRole, 'None' | 'Heading'>, string> = {
  Paragraph: 'p',
  Label: 'span',
  Link: 'a',
  Button: 'button',
  Image: 'img',
  List: 'ul',
  ListItem: 'li',
  Navigation: 'nav',
  Main: 'main',
  Section: 'section',
};

/** Pull the URL out of a `Url("...", Fit, Placeholder)` Background value. */
export const ExtractBackgroundUrl = (background: unknown): string | null => {
  if (typeof background !== 'string') return null;
  const match = /^\s*Url\(\s*"([^"]+)"/i.exec(background);
  return match ? match[1] : null;
};

/**
 * Resolve what (if anything) an element projects into the semantic mirror.
 * Precedence: template role → JSS style role → implicit-from-declaration
 * (`Href` ⇒ Link; declared `Alt` + image URL ⇒ Image). Undeclared or `None`
 * ⇒ null — the opt-in contract.
 *
 * Heading level: the type scale IS the hierarchy, so JSS carries it —
 * `Semantics: Heading 1`. Bare `Heading` defaults to h2; the template
 * `level` input is the structural override for the exceptions.
 */
export const ResolveSemantics = (source: SemanticsSource): ResolvedSemantics | null => {
  let styleRole: SemanticRole | undefined;
  let styleLevel: number | undefined;
  if (source.StyleRole) {
    const [head, tail] = source.StyleRole.trim().split(/\s+/);
    if (Roles.has(head)) {
      styleRole = head as SemanticRole;
      const parsed = Number(tail);
      if (Number.isFinite(parsed)) styleLevel = parsed;
    }
  }
  let role = source.Role ?? styleRole;
  if (!role) {
    if (source.Href) role = 'Link';
    else if (source.Alt != null && source.BackgroundUrl) role = 'Image';
    else return null;
  }
  if (role === 'None') return null;

  const tag = role === 'Heading'
    ? `h${Math.min(6, Math.max(1, Math.round(source.Level ?? styleLevel ?? 2)))}`
    : Tags[role];
  const interactive = tag === 'a' || tag === 'button';
  return {
    Tag: tag,
    Text: role === 'Image' ? null : source.Text ?? null,
    Href: role === 'Link' ? source.Href ?? null : null,
    Src: role === 'Image' ? source.BackgroundUrl ?? null : null,
    Alt: role === 'Image' ? source.Alt ?? '' : null,
    Label: source.Label ?? null,
    TabIndex: interactive ? -1 : null,
  };
};
