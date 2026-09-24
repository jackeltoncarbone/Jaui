import type { JivStyle } from '../Jiv/Jiv.Types';

/** Apple's two glass variants as styles (Core/Glass.md): the size and the backdrop set everything else. */
export const LiquidGlass: Partial<JivStyle> = {
  Background: 'rgba(255, 255, 255, 0)',
  BorderRadius: '32',
  Glass: 'Regular',
  Refraction: '1',
  RimWidth: '1',
  RimStrength: '0.5',
};

export const ClearGlass: Partial<JivStyle> = {
  ...LiquidGlass,
  Glass: 'Clear',
};
