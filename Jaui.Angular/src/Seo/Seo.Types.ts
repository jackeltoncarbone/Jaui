import { InjectionToken } from '@angular/core';

/** Semantic roles a Jiv can declare — via JSS (`Semantics: Heading` on a style
 *  class) or the `semantics` template input. Opt-in: an undeclared element
 *  projects nothing. Roles are never inferred from visual style. */
export type SemanticRole =
  | 'None'
  | 'Heading'
  | 'Paragraph'
  | 'Label'
  | 'Link'
  | 'Button'
  | 'Image'
  | 'List'
  | 'ListItem'
  | 'Navigation'
  | 'Main'
  | 'Section';

/** What the mirror renders for one element once all sources are resolved. */
export interface ResolvedSemantics {
  Tag: string;
  Text: string | null;
  Href: string | null;
  Src: string | null;
  Alt: string | null;
  Label: string | null;
  TabIndex: number | null;
}

/** SPA navigation hook for `href` activation (canvas tap or mirror anchor).
 *  Consumers provide a Router-backed factory; without one, Jaui falls back
 *  to `location.assign`. */
export const JAUI_NAVIGATE = new InjectionToken<(url: string) => void>('JAUI_NAVIGATE');
