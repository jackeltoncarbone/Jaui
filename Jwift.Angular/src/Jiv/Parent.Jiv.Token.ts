import { InjectionToken } from '@angular/core';
import type { Jiv } from 'jwift';

/**
 * DI token for the parent Jiv. Each `<jwift-canvas>` provides its root Jiv;
 * each `<jiv>` provides itself for descendants. `<jiv>` and `<jext>` inject
 * this to know who to attach themselves to.
 */
export const PARENT_JIV = new InjectionToken<Jiv>('PARENT_JIV');
