/**
 * Jaui.Trace — the engine's own boot tracer hook.
 *
 * The engine cannot import the host app's tracer: the app depends on Jaui, never the other way
 * round. So Jaui NAMES its moments and the host decides where they go. Show Studio installs
 * `Diagnostics/Trace.ts`'s `Mark` on both sides — page and worker — behind `?trace`, which puts
 * engine marks on the same timeline as `angular:bootstrapped` and `surface:rendered:home`.
 *
 * With no sink installed this is one null check, and every caller is on a boot or first-frame
 * path — there is no per-frame mark. That is deliberate: a tracer that costs something in the
 * steady state is a tracer nobody leaves in.
 */

export type JauiTraceSink = (name: string) => void;

let _sink: JauiTraceSink | null = null;

/** Install the sink every engine mark goes to, or clear it with null. */
export const OnJauiTrace = (sink: JauiTraceSink | null): void => { _sink = sink; };

/** True when somebody is listening. Guard a mark whose NAME costs something to build. */
export const JauiTracing = (): boolean => _sink !== null;

/** Name a moment. A no-op with no sink installed. */
export const JTrace = (name: string): void => {
  if (!_sink) return;
  try { _sink(name); } catch { /* a tracer must never be able to take the frame down */ }
};

/** Round to one decimal for a mark name — enough to read, short enough not to bloat the report. */
export const JMs = (ms: number): string => (ms < 10 ? ms.toFixed(1) : String(Math.round(ms)));
