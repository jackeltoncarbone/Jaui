/**
 * Lane gatebisect - `?glass-gates`, read out of the REAL `Jiv.Panel.frag`.
 *
 * No GLSL compiler runs here, so every claim is about the TEXT the preprocessor leaves:
 *
 *   1. THE BISECT. Under GLASS_NO_GATE_<S> every gate call site and every statement of the shipped
 *      program is still there; what changes is `GlassSkips`, which can no longer answer yes for S
 *      (its kept mask, read off the text, is the other nine). All ten together is
 *      GLASS_NO_SKIP_GATES (`?glass-reg=nogates`) byte for byte, comments included, on every kind.
 *   2. THE EXTENSION. Under GLASS_GATE_<B> the program gains `u_GlassGate`, its helper, and ONE gate
 *      line with its closing brace; take those away (and fold each value a gated block hands on back
 *      into its declaration) and what is left is the shipped program, line for line.
 *   3. Every variant is whole: balanced, every read declared and in scope (lane glassreg's walker).
 *   4. THE GATE MAP: the components carried through each gate's region, old and new, per shipped
 *      program, asserted as numbers - the prediction the Mac's per-arm readings land in.
 *   5. The wiring: what compiles when, what the draw uploads, what Jaui prints and refuses.
 */
import { describe, it, expect } from 'vitest';
import { braceBalance, readRenderer, stripTsComments, linesNotIn, readPanelFrag } from './Flat.Program.Source';
import { mainOf, walkScopes, foldGlassArms, heldAcross, ANCHORS, type Anchor, type Line } from './Glass.Reg.Source';
import {
  STAGES, BARRIERS, gateProgram, gateProgramRaw, noGate, barrierDefine, gateSites, gatePeaks, blockEnd,
} from './Glass.Gates.Source';
import { arrowBody, readJaui } from './Scene.ReadAfterWrite.Source';
import { GLASS_SKIP_STAGES, GLASS_SKIP_ALL, type GlassSkipStage } from '@jaui/Core/Glass.Skip';
import {
  GLASS_GATE_BARRIERS, GLASS_GATE_OPEN, GlassGatesDefines, ParseGlassGates, GLASS_PROGRAM_KINDS,
  type GlassGateBarrier, type GlassProgramKind,
} from '@jaui/Core/Glass.Programs';
import { GLASS_GATE_PROGRAMS } from '@jaui/Core/WebGL2.Renderer';

const text = (ls: readonly Line[]): string[] => ls.map((l) => l.Text);
const ALL_TEN = STAGES.map(noGate);
const KIND_DEFINES: Record<GlassProgramKind, string[]> = {
  full: ['MATERIAL_GLASS'],
  borderOnly: ['MATERIAL_GLASS', 'GLASS_BORDER_ONLY'],
  noLight: ['MATERIAL_GLASS', 'GLASS_NO_GLOW', 'GLASS_NO_SPEC'],
};

/** The bits `GlassSkips` can answer yes for in a program, read off its text. */
const keptMask = (lines: readonly Line[]): number => {
  const t = text(lines);
  if (t.includes('bool GlassSkips(int bit) { return false; }')) return 0;
  if (t.includes('bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }')) return GLASS_SKIP_ALL;
  expect(t).toContain('bool GlassSkips(int bit) { return (u_GlassSkip & (GLASS_GATES_KEPT & bit)) != 0; }');
  const at = t.indexOf('const int GLASS_GATES_KEPT = 0');
  expect(at).toBeGreaterThan(0);
  let mask = 0;
  for (let i = at + 1; t[i] !== ';'; i++) {
    const m = /^\| GLASS_SKIP_([A-Z]+)$/.exec(t[i]);
    if (m === null) throw new Error(`unexpected line in GLASS_GATES_KEPT: ${t[i]}`);
    mask |= GLASS_SKIP_STAGES[m[1].toLowerCase() as GlassSkipStage];
  }
  return mask;
};

/** The lines that define `GlassSkips` (and, when masked, its kept mask): everything else in a
 *  bisect program must be the shipped program's. */
const isSkipDefinition = (t: string): boolean =>
  t.startsWith('bool GlassSkips(int bit)') || t === 'const int GLASS_GATES_KEPT = 0'
  || /^\| GLASS_SKIP_[A-Z]+$/.test(t) || t === ';';

// ── 1. THE BISECT ───────────────────────────────────────────────────────────────────────────────

describe('GLASS_NO_GATE_<S> - one gate compiled away, every statement kept', () => {
  for (const kind of GLASS_PROGRAM_KINDS) {
    const shipped = gateProgram(kind);

    it(`${kind}: the shipped program keeps all ten gates in GlassSkips`, () => {
      expect(keptMask(shipped)).toBe(GLASS_SKIP_ALL);
      expect(text(shipped).join('\n')).not.toMatch(/GLASS_GATES_KEPT|u_GlassGate|GlassGate\(/);
    });

    for (const s of STAGES) {
      it(`${kind}: ${s} alone - GlassSkips can no longer say yes to it, and nothing else moved`, () => {
        const p = gateProgram(kind, [noGate(s)]);
        expect(keptMask(p)).toBe(GLASS_SKIP_ALL & ~GLASS_SKIP_STAGES[s]);
        // The code present: every line of the shipped program but the GlassSkips definition is here,
        // at the same source line, including every gate CALL SITE.
        expect(linesNotIn(shipped, p).map((l) => l.Text)).toEqual(['bool GlassSkips(int bit) { return (u_GlassSkip & bit) != 0; }']);
        expect(linesNotIn(p, shipped).every((l) => isSkipDefinition(l.Text))).toBe(true);
        expect(text(p).filter((t) => !isSkipDefinition(t))).toEqual(text(shipped).filter((t) => !isSkipDefinition(t)));
      });
    }

    it(`${kind}: a list is the union - the kept mask is what is left`, () => {
      const p = gateProgram(kind, [noGate('backdrop'), noGate('sdf'), noGate('shadow')]);
      expect(keptMask(p)).toBe(GLASS_SKIP_ALL & ~(1 | 32 | 128));
    });

    it(`${kind}: all ten IS ?glass-reg=nogates, byte for byte in the preprocessed source`, () => {
      const all = gateProgramRaw([...KIND_DEFINES[kind], ...ALL_TEN]);
      const nogates = gateProgramRaw([...KIND_DEFINES[kind], 'GLASS_NO_SKIP_GATES']);
      // Every line, comments and blanks included, and every original line number.
      expect(all).toEqual(nogates);
      expect(keptMask(gateProgram(kind, ALL_TEN))).toBe(0);
    });
  }

  it('nine of ten is not ten: the arm is exact about which gates it removed', () => {
    const nine = gateProgram('full', ALL_TEN.slice(0, 9));
    expect(keptMask(nine)).toBe(GLASS_SKIP_STAGES.clip);
  });

  it('MATERIAL_NONE and MATERIAL_FLAT never see any of it', () => {
    for (const d of [...ALL_TEN, ...BARRIERS.map(barrierDefine)]) {
      const none = gateProgramRaw(['MATERIAL_NONE', d]).map((l) => l.Text);
      expect(none, d).toEqual(gateProgramRaw(['MATERIAL_NONE']).map((l) => l.Text));
      const flat = gateProgramRaw(['MATERIAL_FLAT', d]).map((l) => l.Text);
      expect(flat, d).toEqual(gateProgramRaw(['MATERIAL_FLAT']).map((l) => l.Text));
    }
  });

  it('WHICH gates each shipped program contains: rim and specular are in NEITHER', () => {
    // The finding the bisect's predictions rest on. The fill runs NO_LIGHT and the rim BORDER_ONLY
    // on glass-grid (lane glassreg's default), and both compile the rim glow and the catchlight out
    // with their gates. So GLASS_NO_GATE_RIM and GLASS_NO_GATE_SPECULAR change NO shipped program's
    // code - they are the cell's two built-in null controls.
    const gatesIn = (kind: GlassProgramKind): string[] => {
      const t = text(gateProgram(kind)).join('\n');
      return STAGES.filter((s) => t.includes(`GlassSkips(GLASS_SKIP_${s.toUpperCase()})`));
    };
    expect(gatesIn('full')).toEqual([...STAGES]);
    expect(gatesIn('noLight')).toEqual(['backdrop', 'ca', 'border', 'sdf', 'grade', 'shadow', 'skirt', 'clip']);
    expect(gatesIn('borderOnly')).toEqual(['backdrop', 'border', 'sdf', 'skirt', 'clip']);
  });
});

// ── 2. THE EXTENSION ────────────────────────────────────────────────────────────────────────────

/** The shipped program recovered from a `+<barrier>` program: the gate's declarations and its one
 *  gate line with its closing brace removed, and each predeclared value folded back into its first
 *  assignment. Returns the remaining text and what was removed. */
const unbarrier = (lines: readonly Line[], b: GlassGateBarrier): { Text: string[]; Gate: number; Outputs: string[] } => {
  const out = [...lines];
  const B = b.toUpperCase();
  const gate = out.findIndex((l) => l.Text === `if (GlassGate(GLASS_BARRIER_${B})) {`);
  expect(gate, b).toBeGreaterThan(0);
  const end = blockEnd(out, gate);
  expect(out[end].Text, b).toBe('}');
  // Predeclared outputs sit directly above the gate.
  const types = new Map<string, string>();
  let first = gate;
  while (/^(float|vec2|vec3|vec4) \w+;$/.test(out[first - 1].Text)) {
    const [type, name] = out[first - 1].Text.slice(0, -1).split(' ');
    types.set(name, type);
    first--;
  }
  const body = out.slice(gate + 1, end).map((l) => {
    const m = /^([A-Za-z_]\w*) = /.exec(l.Text);
    return m !== null && types.has(m[1]) ? { ...l, Text: `${types.get(m[1])} ${l.Text}` } : l;
  });
  const rebuilt = [...out.slice(0, first), ...body, ...out.slice(end + 1)];
  const decl = (t: string): boolean => t === 'uniform int u_GlassGate;' || /^const int GLASS_BARRIER_[A-Z]+ += \d+;$/.test(t)
    || t === 'bool GlassGate(int bit) { return (u_GlassGate & bit) != 0; }';
  return { Text: rebuilt.map((l) => l.Text).filter((t) => !decl(t)), Gate: gate, Outputs: [...types.keys()].reverse() };
};

/** Which kinds contain each new gate's statements (a rim overlay has no absorption or ambient). */
const BARRIER_KINDS: Record<GlassGateBarrier, GlassProgramKind[]> = {
  bezel: ['full', 'borderOnly', 'noLight'],
  refract: ['full', 'borderOnly', 'noLight'],
  lod: ['full', 'borderOnly', 'noLight'],
  grad: ['full', 'borderOnly', 'noLight'],
  absorb: ['full', 'noLight'],
  ambient: ['full', 'noLight'],
};
const BARRIER_OUTPUTS: Record<GlassGateBarrier, string[]> = {
  bezel: ['bend', 'hump'], refract: ['refractOffset'], lod: [], grad: [], absorb: [], ambient: [],
};

describe('GLASS_GATE_<B> - a new TRUE gate around statements that are otherwise the shipped ones', () => {
  it('the shader declares exactly the bits Glass.Programs names, and the renderer opens every one', () => {
    const t = text(gateProgram('full', BARRIERS.map(barrierDefine)));
    const declared = t.map((l) => /^const int GLASS_BARRIER_([A-Z]+) += (\d+);$/.exec(l)).filter((m) => m !== null)
      .map((m) => [m![1].toLowerCase(), Number(m![2])]);
    expect(Object.fromEntries(declared)).toEqual(GLASS_GATE_BARRIERS);
    expect(GLASS_GATE_OPEN).toBe(Object.values(GLASS_GATE_BARRIERS).reduce((a, x) => a | x, 0));
    for (const b of BARRIERS) expect(GLASS_GATE_OPEN & GLASS_GATE_BARRIERS[b], b).toBe(GLASS_GATE_BARRIERS[b]);
  });

  for (const b of BARRIERS) {
    for (const kind of GLASS_PROGRAM_KINDS) {
      const present = BARRIER_KINDS[b].includes(kind);
      it(`+${b} on ${kind}: ${present ? 'one gate, the uniform, and the shipped statements' : 'absent with its statements'}`, () => {
        const shipped = gateProgram(kind);
        const p = gateProgram(kind, [barrierDefine(b)]);
        const t = text(p);
        if (!present) {
          expect(t.filter((l) => l.includes('GlassGate(GLASS_BARRIER_'))).toEqual([]);
          return;
        }
        expect(t.filter((l) => l.includes('GlassGate(GLASS_BARRIER_'))).toEqual([`if (GlassGate(GLASS_BARRIER_${b.toUpperCase()})) {`]);
        expect(t).toContain('uniform int u_GlassGate;');
        const u = unbarrier(p, b);
        expect(u.Outputs, b).toEqual(BARRIER_OUTPUTS[b]);
        // The block's statements are unchanged: the program minus the gate IS the shipped program.
        expect(u.Text).toEqual(text(shipped));
      });
    }
  }

  it('the six together: each gate once, and the same recovery', () => {
    const p = gateProgram('noLight', BARRIERS.map(barrierDefine));
    expect(text(p).filter((l) => l.startsWith('if (GlassGate(')).length).toBe(6);
    let rest: Line[] = p;
    for (const b of BARRIERS) rest = unbarrier(rest, b).Text.map((t, i) => ({ N: i, Text: t }));
    // `unbarrier` drops the shared declarations on its first pass; the recovery still lands.
    expect(text(rest)).toEqual(text(gateProgram('noLight')));
  });

  it('the gate the draw uploads is TRUE for every bit, so every gated block runs', () => {
    for (const b of BARRIERS) expect((GLASS_GATE_OPEN & GLASS_GATE_BARRIERS[b]) !== 0, b).toBe(true);
  });
});

// ── 3. WHOLENESS ────────────────────────────────────────────────────────────────────────────────

describe('every ?glass-gates variant is whole: balanced, every read declared and in scope', () => {
  const sets: Array<[string, string[]]> = [
    ...STAGES.map((s): [string, string[]] => [s, [noGate(s)]]),
    ['all', ALL_TEN],
    ...BARRIERS.map((b): [string, string[]] => [`+${b}`, [barrierDefine(b)]]),
    ['+all six', BARRIERS.map(barrierDefine)],
    ['all,+all six', [...ALL_TEN, ...BARRIERS.map(barrierDefine)]],
  ];
  for (const kind of GLASS_PROGRAM_KINDS) {
    for (const [name, defs] of sets) {
      it(`${kind} ${name}`, () => {
        const lines = gateProgram(kind, defs);
        expect(braceBalance(lines)).toBe(0);
        const walk = walkScopes(mainOf(lines));
        expect(walk.Dangling, `${kind} ${name}`).toEqual([]);
        expect(walk.Redeclared, `${kind} ${name}`).toEqual([]);
        expect(walk.Locals.length).toBeGreaterThan(40);
      });
    }
  }
});

// ── 4. THE GATE MAP ─────────────────────────────────────────────────────────────────────────────
//
// Components CARRIED THROUGH each gate's region (declared before it, read after it; a value a gated
// block hands on is its output, not carried). Function-level gates are counted at each call site in
// `main` and the largest is shown: `backdrop` at every tap, `sdf` at the main field and the shadow's,
// `clip` at the clip stack. `-` = the program does not contain that gate. New gates are measured
// each in its own `+<gate>` program.
//
//                         skirt clip  sdf  bezel refract lod   ca  backdrop grade absorb shadow ambient rim spec border  grad
const MAP: Record<GlassProgramKind, Record<string, number | null>> = {
  full:       { skirt: 0, clip: 0, sdf: 29, '+bezel': 14, '+refract': 24, '+lod': 27, ca: 28, backdrop: 34, grade: 23, '+absorb': 22, shadow: 29, '+ambient': 27, rim: 31, specular: 17, border: 5, '+grad': 10 },
  noLight:    { skirt: 0, clip: 0, sdf: 23, '+bezel': 14, '+refract': 24, '+lod': 27, ca: 27, backdrop: 26, grade: 20, '+absorb': 18, shadow: 23, '+ambient': 21, rim: null, specular: null, border: 5, '+grad': 10 },
  borderOnly: { skirt: 0, clip: 0, sdf: 7, '+bezel': 11, '+refract': 13, '+lod': 10, ca: null, backdrop: 8, grade: null, '+absorb': null, shadow: null, '+ambient': null, rim: null, specular: null, border: 5, '+grad': 7 },
};

const mapOf = (kind: GlassProgramKind): Record<string, number | null> => {
  const out: Record<string, number | null> = {};
  const shipped = gatePeaks(gateSites(gateProgram(kind)));
  for (const s of STAGES) out[s] = shipped[s] ?? null;
  for (const b of BARRIERS) out[`+${b}`] = gatePeaks(gateSites(gateProgram(kind, [barrierDefine(b)])))[`+${b}`] ?? null;
  return out;
};

describe('the gate map, computed from the source', () => {
  for (const kind of GLASS_PROGRAM_KINDS) {
    it(`${kind}: carried through each gate`, () => {
      const m = mapOf(kind);
      expect(Object.fromEntries(Object.keys(MAP[kind]).map((k) => [k, m[k]]))).toEqual(MAP[kind]);
    });
  }

  it('the named findings the predictions rest on', () => {
    const fill = mapOf('noLight');
    const rim = mapOf('borderOnly');
    // The shipped FILL's largest carried set among the ten is the chromatic gate, beside the taps;
    // among the new gates it is `+lod`, which sits at the fill program's register peak.
    const ten = STAGES.filter((s) => fill[s] !== null).sort((a, b) => fill[b]! - fill[a]!);
    expect(ten[0]).toBe('ca');
    const added = BARRIERS.map((b) => `+${b}`).sort((a, b) => fill[b]! - fill[a]!);
    expect(added[0]).toBe('+lod');
    // In the RIM program the refraction chain is the largest set any gate touches, old or new.
    const rimAll = Object.entries(rim).filter(([, v]) => v !== null).sort((a, b) => b[1]! - a[1]!);
    expect(rimAll[0][0]).toBe('+refract');
    // Nothing is carried through the two gates at the head of main: the skirt discard and the clip
    // stack run before the first value is made.
    expect([fill.skirt, fill.clip, rim.skirt, rim.clip]).toEqual([0, 0, 0, 0]);
  });

  it('a new gate moves no value: every heavy statement holds what it held without it', () => {
    // The register map of lane glassreg, per anchor, for the shipped program and each `+<gate>`
    // program. Only a gate's own outputs (declared a few lines early, ahead of the gate) can add.
    const held = (lines: readonly Line[]): Record<string, number | null> => {
      const main = foldGlassArms(mainOf(lines));
      const walk = walkScopes(main);
      const out: Record<string, number | null> = {};
      for (const a of Object.keys(ANCHORS) as Anchor[]) out[a] = heldAcross(main, walk, a)?.Components ?? null;
      return out;
    };
    for (const kind of GLASS_PROGRAM_KINDS) {
      const base = held(gateProgram(kind));
      for (const b of BARRIERS) {
        const withGate = held(gateProgram(kind, [barrierDefine(b)]));
        expect(withGate, `${kind} +${b}`).toEqual(base);
      }
    }
  });
});

// ── 5. THE ARM, THE WIRING, THE MARKS ───────────────────────────────────────────────────────────

describe('?glass-gates - the parse and the define sets', () => {
  it('off is null; the bare flag and `all` are the ten; lists are canonical', () => {
    expect(ParseGlassGates(null)).toBeNull();
    expect(ParseGlassGates('off')).toBeNull();
    expect(ParseGlassGates('')!.Key).toBe('all');
    expect(ParseGlassGates('all')).toEqual({ Removed: STAGES, Barriers: [], Key: 'all' });
    expect(ParseGlassGates('shadow,backdrop')).toEqual({ Removed: ['backdrop', 'shadow'], Barriers: [], Key: 'backdrop,shadow' });
    expect(ParseGlassGates('+lod,rim')).toEqual({ Removed: ['rim'], Barriers: ['lod'], Key: 'rim,+lod' });
    // A `+` decoded to a space by URLSearchParams, and a bare barrier name, both mean the new gate.
    expect(ParseGlassGates(' ambient, grad')!.Key).toBe('+grad,+ambient');
    expect(ParseGlassGates('lod')!.Key).toBe('+lod');
    expect(ParseGlassGates('all,+refract')!.Key).toBe('all,+refract');
  });

  it('anything else throws by name', () => {
    expect(() => ParseGlassGates('shadows')).toThrow(/got 'shadows'/);
    expect(() => ParseGlassGates('+sdf')).toThrow(/'sdf' is one of the ten gates/);
    expect(() => ParseGlassGates('rim,,lod')).toThrow(/got ''/);
  });

  it('the defines: GLASS_NO_GATE_<STAGE> per gate removed, GLASS_GATE_<GATE> per gate added', () => {
    expect(GlassGatesDefines(ParseGlassGates('all')!)).toEqual(Object.fromEntries(ALL_TEN.map((d) => [d, true])));
    expect(GlassGatesDefines(ParseGlassGates('sdf,+lod,+grad')!))
      .toEqual({ GLASS_NO_GATE_SDF: true, GLASS_GATE_LOD: true, GLASS_GATE_GRAD: true });
    // Every define the arm can issue is one the shader reads.
    const all = GlassGatesDefines(ParseGlassGates(`all,${BARRIERS.map((b) => `+${b}`).join(',')}`)!);
    expect(Object.keys(all).length).toBe(16);
    for (const d of Object.keys(all)) expect(readPanelFrag().includes(`defined(${d})`), d).toBe(true);
  });
});

describe('the renderer and Jaui: compiled on the arm, bound in place of the boot family, printed', () => {
  const R = stripTsComments(readRenderer());
  const J = readJaui().replace(/\r\n/g, '\n');

  it('compiles the three on the arm, off the surviving value, in its own batch; a restore drops them', () => {
    expect(GLASS_GATE_PROGRAMS).toBe(3);
    const arm = arrowBody(R, 'ArmFlaggedPrograms');
    expect(arm).toContain('const gates = this.DiagGlassGates !== null ? this.EnsureGlassGatePrograms() : 0;');
    expect(arm).toContain('const late = pool + atlas + border + gauss + reg + gates;');
    expect(R).toContain('if (this.DiagGlassGates !== null) this.EnsureGlassGatePrograms(batch);');
    expect(R.indexOf('this._glassGateShaders = null;')).toBeLessThan(R.indexOf('const batch = new ShaderBatch(gl);'));
    const ensure = arrowBody(R, 'EnsureGlassGatePrograms');
    expect(ensure).toContain('if (arm === null) return 0;');
    expect(ensure).toContain('if (this._glassGateShaders !== null && this._glassGatesCut === arm.Key) return 0;');
    expect(ensure).toContain('{ MATERIAL_GLASS: true, ...GLASS_VARIANT_DEFINES[kind], ...GlassGatesDefines(arm) });');
    expect(ensure).toContain("if (this.DiagGlassReg !== 'off') {");
    expect(R).toContain('DiagGlassGates: GlassGatesArm | null = null;');
  });

  it('the pick: ?glass-reg or ?glass-gates in the family slot, and the gate word uploaded open', () => {
    expect(R).toContain(": this.DiagGlassGates !== null ? this._glassGatesOrThrow(glassKind)");
    expect(R).toContain('gl.uniform1i(locs.glassGate, isGlass ? GLASS_GATE_OPEN : 0);');
    expect(R).toContain("glassGate:      gl.getUniformLocation(p, 'u_GlassGate'),");
  });

  it('the mark, the refusals, and the parse order', () => {
    expect(J).toContain("JTrace(`jaui:glass-gates armed=${this._glassGates === null ? 'off' : this._glassGates.Key}`");
    expect(J).toContain("+ ` programs=${this._glassGates === null ? 0 : GLASS_GATE_PROGRAMS}`");
    expect(J).toContain("? 'glass-gates-compiles-the-gates-away-add-glass-gates=off'");
    expect(J).toContain("' reason=glass-gates-cuts-the-glass-family-add-glass-gates=off'");
    // Ahead of ?glass-reg (which it refuses) and ?glass-skip (which it refuses).
    const gates = J.indexOf("ParseGlassGates(params.has('glass-gates')");
    expect(gates).toBeGreaterThan(0);
    expect(gates).toBeLessThan(J.indexOf("ParseGlassReg(params.has('glass-reg')"));
    expect(gates).toBeLessThan(J.indexOf("ParseGlassSkip(params.get('glass-skip')"));
  });
});
