import type { Jiv } from '../../Jiv/Jiv';

/** Whether the last significant input was keyboard or pointer. Drives
 *  `:FocusVisible` — rings show for keyboard, hide for pointer (Phase 2). */
export type InputModality = 'keyboard' | 'pointer';

/** Owns the engine's focus state. Phase 0: FocusedScroller + modality only.
 *  Phase 2 adds CurrentFocus, tab-order traversal, trap stack, and restoration. */
export class FocusManager {
  private _focusedScroller: Jiv | null = null;
  private _modality: InputModality = 'pointer';

  get FocusedScroller(): Jiv | null { return this._focusedScroller; }
  get Modality(): InputModality { return this._modality; }

  SetFocusedScroller = (jiv: Jiv | null): void => {
    this._focusedScroller = jiv;
  };

  SetModality = (m: InputModality): void => {
    this._modality = m;
  };
}
