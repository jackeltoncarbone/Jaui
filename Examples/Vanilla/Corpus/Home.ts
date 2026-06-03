// Show Studio — Home, rebuilt for the visionOS SPATIAL aesthetic.
// Spec: Jwift Design/{Aesthetic,Layout,Components,VisionOS}.md + ShowStudio
// App.Design/Concentric/Sizing.md. A calm dark room where everything FLOATS:
//   - Floating Liquid-Glass nav rail (Home · Shop · Library) — inset with a gap,
//     concentric corners, slightly proud — NOT a docked flush panel.
//   - Scrollable content column (the page scrolls; nav stays).
//   - Solid-Glass cards (rgba(255,255,255,.06) + luminous border), concentric
//     radii, hover-lift + press-dip feedback.
//   - An inline 3D field/formation as the floating featured hero (Model3D), and
//     an inline inspectable item (RotationView) in a content row.
//   - One blue accent; off-white bold text; depth + the scene light do the rest.
import * as THREE from 'three';
import { Canvas, Jiv, LiquidGlass, Model3D, RotationView } from 'jaui';
import type { PredicateStyle, JivStyle } from 'jaui';

// ── Palette / system (from Sizing.md + Aesthetic.md) ──────────────────────────
const ACCENT = 'rgb(10,132,255)';
const TEXT = 'rgba(255,255,255,0.96)';
const TEXT_2 = 'rgba(255,255,255,0.46)';
const TEXT_3 = 'rgba(255,255,255,0.34)';
const SOLID_GLASS_BG = 'rgba(255,255,255,0.06)';
const SOLID_GLASS_BORDER = 'rgba(255,255,255,0.12)';

// iOS 26 = EXTREME roundness (per iOS18.vs.26.md: "significantly larger radii
// everywhere"). On big cards a small r reads tight, so these are generous.
const R_HERO = 48;
const R_NAV = 40;
const R_TILE = 52;   // big, clearly-round squircle
const SMOOTH = '0.6';   // squircle fullness s=0.6 → n≈5.6 (the iOS curve)

// Hover/active feedback (the "alive" + visionOS attention response).
const HOVER = (hover: Partial<JivStyle>, active?: Partial<JivStyle>): PredicateStyle[] => {
  const out: PredicateStyle[] = [{ Predicate: { Kind: 'State', Name: 'Hover' }, Style: hover }];
  if (active) out.push({ Predicate: { Kind: 'State', Name: 'Active' }, Style: active });
  return out;
};

// ── Inline 3D hero: a RECOGNIZABLE marching field — a green field with yard
// lines and little glowing marcher figures STANDING on it in a formation.
// (The old version was abstract beads floating in void — you couldn't tell what
// it was. This reads as "a marching band on a field" the moment you see it.)
function formation(): THREE.Object3D {
  const g = new THREE.Group();
  // The field — green turf. DoubleSide + emissive so it READS regardless of
  // light angle / the Model3D pivot's y-flip (which flips the plane's normal
  // away from the lights — that's why it was black). Emissive guarantees green.
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 0.82),
    new THREE.MeshStandardMaterial({
      color: 0x2e7d46, roughness: 0.9, metalness: 0,
      emissive: 0x14532a, emissiveIntensity: 1, side: THREE.DoubleSide,
    }),
  );
  field.rotation.x = -Math.PI / 2;   // lie flat
  g.add(field);
  // Yard lines — white stripes (emissive + DoubleSide so they show on the turf).
  for (let i = -5; i <= 5; i++) {
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(0.01, 0.82),
      new THREE.MeshStandardMaterial({
        color: 0xffffff, emissive: 0x888888, emissiveIntensity: 1,
        side: THREE.DoubleSide, transparent: true, opacity: 0.6,
      }),
    );
    line.rotation.x = -Math.PI / 2; line.position.set(i * 0.11, 0.002, 0);
    g.add(line);
  }
  // Marchers — little glowing capsule "figures" STANDING (upright) on the field
  // in a curved formation. Upright + on the turf = clearly people, not dots.
  const body = new THREE.CapsuleGeometry(0.012, 0.05, 4, 8);
  const ARCS = [{ r: 0.34, n: 18, dz: 0.12 }, { r: 0.24, n: 13, dz: 0 }, { r: 0.15, n: 8, dz: -0.1 }];
  for (const arc of ARCS) for (let i = 0; i < arc.n; i++) {
    const u = i / (arc.n - 1);
    const ang = (u - 0.5) * Math.PI * 0.9;
    const c = new THREE.Color().setHSL(0.57 - u * 0.06, 0.8, 0.62);
    const m = new THREE.Mesh(body, new THREE.MeshStandardMaterial({
      color: c, roughness: 0.35, metalness: 0.2, emissive: c.clone().multiplyScalar(0.55),
    }));
    // stand on the field (y = half-height up), arc across it
    m.position.set(Math.sin(ang) * arc.r, 0.04, -Math.cos(ang) * arc.r * 0.55 + arc.dz);
    g.add(m);
  }
  return g;
}
// An inspectable shop item (glossy gem + ring) for a content tile.
function gem(hue: number): THREE.Object3D {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.42, 0), new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue, 0.65, 0.56), roughness: 0.16, metalness: 0.7,
    emissive: new THREE.Color().setHSL(hue, 0.7, 0.14),
  })));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.52, 0.02, 12, 48),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, metalness: 0.9 }));
  ring.rotation.x = Math.PI / 2.3; g.add(ring);
  return g;
}

export default async function setup(el: HTMLCanvasElement): Promise<void> {
  const canvas = await Canvas.Create(el);

  // Root: TRANSPARENT (the 3D scene backdrop is the "room"; an opaque ancestor
  // would cover the inline 3D). UserSelect:None — app chrome isn't body copy.
  // Bare numbers are POINTS (framework default; engine base 1pt=16px). This page
  // is authored in TRUE pt — small relative values that scale from one outer
  // size, never px-pinned. (px-pinning the root post-construction fought the
  // resolve pipeline and blanked the page.) So a 44px radius is ~2.75pt, etc.
  const root = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch' },
    ChildLayout: { FlexGrow: 1 },
    UserSelect: 'None',
  });
  canvas.Root.AddChild(root);

  // ── Floating glass nav rail (Home · Shop · Library) ───────────────────────
  // Liquid-Glass column INSET with a gap (everything floats), concentric corners.
  const navGutter = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Padding: '16px' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '224px' },
  });
  const nav = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '6px', Padding: '20px 14px' },
    Style: { ...LiquidGlass, BorderRadius: String(R_NAV) },
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  });
  const brand = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Start', Align: 'Center', Gap: '11px', Padding: '8px 10px 20px 10px' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '50px' },
  });
  brand.AddChild(new Jiv({
    Style: { Background: ACCENT, BorderRadius: '7px', ShadowColor: 'rgba(10,132,255,0.6)', ShadowBlur: '12' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '13px', Height: '13px' },
  }));
  brand.AddChild(new Jiv({
    Text: 'Show Studio',
    TextStyle: { FontSize: '17px', FontWeight: 800, Color: TEXT, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 1, Height: '22px' },
  }));
  nav.AddChild(brand);

  const R_NAVITEM = R_NAV - 14;   // concentric: nav radius − its padding
  let current = 'Home';
  const navItems: { label: string; jiv: Jiv }[] = [];
  for (const label of ['Home', 'Shop', 'Library']) {
    const sel = label === current;
    const item = new Jiv({
      Layout: { Direction: 'Row', Justify: 'Start', Align: 'Center', Gap: '12px', Padding: '0px 14px' },
      Style: { Background: sel ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0)', BorderRadius: String(R_NAVITEM) },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '48px' },
      Cursor: 'Pointer',
      PredicateStyles: HOVER(
        { Background: sel ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.07)' },
        { Background: 'rgba(255,255,255,0.04)' },
      ),
    });
    item.AddChild(new Jiv({
      Style: { Background: sel ? ACCENT : 'rgba(255,255,255,0.25)', BorderRadius: '5px' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '9px', Height: '9px' },
    }));
    item.AddChild(new Jiv({
      Text: label,
      TextStyle: { FontSize: '15px', FontWeight: sel ? 700 : 500, Color: sel ? TEXT : TEXT_2, TextAlign: 'Left' },
      ChildLayout: { FlexGrow: 1, Height: '20px' },
    }));
    item.OnClick = () => { current = label; };
    navItems.push({ label, jiv: item });
    nav.AddChild(item);
  }
  navGutter.AddChild(nav);
  root.AddChild(navGutter);

  // ── Scrollable content column (the page scrolls; nav stays floating) ──────
  const scroll = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '20px', Padding: '28px 40px 40px 8px' },
    Overflow: 'Scroll',
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  });
  root.AddChild(scroll);

  // Top bar: greeting + large title, trailing coins + avatar (floating glass).
  const topbar = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Start', Align: 'Center', Gap: '14px' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '60px' },
  });
  const greet = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Start', Gap: '2px' },
    ChildLayout: { FlexGrow: 1, Height: '56px' },
  });
  greet.AddChild(new Jiv({ Text: 'Good evening, Jack',
    TextStyle: { FontSize: '13px', FontWeight: 600, Color: TEXT_3, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '16px' } }));
  greet.AddChild(new Jiv({ Text: 'Home',
    TextStyle: { FontSize: '32px', FontWeight: 800, Color: TEXT, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '40px' } }));
  topbar.AddChild(greet);
  const coins = new Jiv({
    Layout: { Direction: 'Row', Justify: 'Center', Align: 'Center', Padding: '0px 18px' },
    Style: { ...LiquidGlass, BorderRadius: '22px', Thickness: '8px', Fillet: '5px' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '116px', Height: '44px' },
    Cursor: 'Pointer', PredicateStyles: HOVER({ VisualScale: '1.05' }, { VisualScale: '0.98' }),
  });
  coins.AddChild(new Jiv({ Text: '◈ 2,450',
    TextStyle: { FontSize: '15px', FontWeight: 700, Color: TEXT, TextAlign: 'Center' },
    ChildLayout: { FlexGrow: 1, Height: '20px' } }));
  topbar.AddChild(coins);
  const avatar = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Center' },
    Style: { Background: 'rgb(60,160,90)', BorderRadius: '22px', Elevation: '12px', Fillet: '8px', ShadowColor: 'rgba(0,0,0,0.4)', ShadowBlur: '12' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Width: '44px', Height: '44px' },
    Cursor: 'Pointer', PredicateStyles: HOVER({ VisualScale: '1.08' }, { VisualScale: '0.96' }),
  });
  avatar.AddChild(new Jiv({ Text: 'JC',
    TextStyle: { FontSize: '15px', FontWeight: 800, Color: TEXT, TextAlign: 'Center' },
    ChildLayout: { FlexGrow: 0, Height: '20px' } }));
  topbar.AddChild(avatar);
  scroll.AddChild(topbar);

  // ── Featured hero: a floating inline 3D field, glass caption over it ──────
  const hero = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '16px', Padding: '16px' },
    Style: { Background: 'rgba(0,0,0,0)', BorderRadius: String(R_HERO), BorderRadiusSmoothness: SMOOTH,
      BorderWidth: '1', BorderColor: 'rgba(255,255,255,0.12)',
      ShadowColor: 'rgba(0,0,0,0.5)', ShadowBlur: '44', ShadowOffsetY: '16' },
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '380px' },
  });
  const stage = new RotationView({
    AutoSpin: true, Pitch: -0.5,
    Content: new Model3D({ Object: formation(), Fit: 0.92, Background: [0.05, 0.055, 0.075] }),
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  });
  hero.AddChild(stage);
  const heroCard = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Center', Align: 'Start', Gap: '5px', Padding: '16px 20px' },
    // Thickness gives the glass real slab depth (refraction + a beveled lit edge)
    // — physical presence, like a pane of glass floating in the room.
    Style: { ...LiquidGlass, BorderRadius: String(R_HERO - 16), BorderRadiusSmoothness: SMOOTH, Thickness: '10px', Fillet: '6px' },   // concentric
    ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '94px' },
  });
  heroCard.AddChild(new Jiv({ Text: 'Featured show',
    TextStyle: { FontSize: '11px', FontWeight: 800, Color: ACCENT, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '14px' } }));
  heroCard.AddChild(new Jiv({ Text: 'Knight Rising',
    TextStyle: { FontSize: '24px', FontWeight: 800, Color: TEXT, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '30px' } }));
  heroCard.AddChild(new Jiv({ Text: 'Westfield HS · 48K plays · drag to inspect',
    TextStyle: { FontSize: '13px', FontWeight: 500, Color: TEXT_2, TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '17px' } }));
  hero.AddChild(heroCard);
  scroll.AddChild(hero);

  // ── Content rows: Solid-Glass tiles; one inline-3D inspectable item ───────
  const sectionTitle = (t: string): Jiv => new Jiv({ Text: t,
    TextStyle: { FontSize: '20px', FontWeight: 700, Color: 'rgba(255,255,255,0.88)', TextAlign: 'Left' },
    ChildLayout: { FlexGrow: 0, Height: '26px' } });
  const metaBlock = (title: string, sub: string): Jiv => {
    const m = new Jiv({ Layout: { Direction: 'Column', Justify: 'Start', Align: 'Start', Gap: '2px' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '38px' } });
    m.AddChild(new Jiv({ Text: title, TextStyle: { FontSize: '14px', FontWeight: 650, Color: TEXT, TextAlign: 'Left' }, ChildLayout: { FlexGrow: 0, Height: '19px' } }));
    m.AddChild(new Jiv({ Text: sub, TextStyle: { FontSize: '12px', FontWeight: 500, Color: TEXT_3, TextAlign: 'Left' }, ChildLayout: { FlexGrow: 0, Height: '16px' } }));
    return m;
  };
  const gradientCover = (a: string, b: string): Jiv => new Jiv({
    Layout: { Direction: 'Column' },
    // Elevation = physical THICKNESS (a raised, beveled slab that catches the
    // scene light) — real presence, not a flat panel. Fillet rounds the slab edge.
    Style: { Background: `LinearGradient(180deg, ${a} 0%, ${b} 100%)`, BorderRadius: String(R_TILE), BorderRadiusSmoothness: SMOOTH,
      Elevation: '14px', Fillet: '10px',
      BorderWidth: '1', BorderColor: SOLID_GLASS_BORDER, ShadowColor: 'rgba(0,0,0,0.45)', ShadowBlur: '26', ShadowOffsetY: '12' },
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  });
  const tile = (cover: Jiv, title: string, sub: string): Jiv => {
    const t = new Jiv({ Layout: { Direction: 'Column', Justify: 'End', Align: 'Stretch', Gap: '9px' },
      ChildLayout: { FlexGrow: 1, FlexShrink: 1 }, Cursor: 'Pointer',
      PredicateStyles: HOVER({ VisualScale: '1.04' }, { VisualScale: '0.99' }) });
    t.AddChild(cover); t.AddChild(metaBlock(title, sub));
    return t;
  };
  const rowOf = (...tiles: Jiv[]): Jiv => {
    const r = new Jiv({ Layout: { Direction: 'Row', Justify: 'Start', Align: 'Stretch', Gap: '14px' }, ChildLayout: { FlexGrow: 1, FlexShrink: 1 } });
    for (const t of tiles) r.AddChild(t);
    return r;
  };
  const sectionOf = (title: string, row: Jiv): Jiv => {
    const s = new Jiv({ Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch', Gap: '12px' },
      ChildLayout: { FlexGrow: 0, FlexShrink: 0, Height: '236px' } });
    s.AddChild(sectionTitle(title)); s.AddChild(row); return s;
  };

  // Trending — includes the inline-3D "Aurora Plume" item.
  const gemCover = new Jiv({
    Layout: { Direction: 'Column', Justify: 'Start', Align: 'Stretch' },
    Style: { Background: 'rgba(0,0,0,0)', BorderRadius: String(R_TILE), BorderWidth: '1',
      BorderColor: SOLID_GLASS_BORDER, ShadowColor: 'rgba(0,0,0,0.4)', ShadowBlur: '22', ShadowOffsetY: '9' },
    ChildLayout: { FlexGrow: 1, FlexShrink: 1 },
  });
  gemCover.AddChild(new RotationView({ AutoSpin: true, SpinSpeed: 0.6, Pitch: -0.1,
    Content: new Model3D({ Object: gem(0.58), Fit: 0.62 }), ChildLayout: { FlexGrow: 1, FlexShrink: 1 } }));
  scroll.AddChild(sectionOf('Trending shows', rowOf(
    tile(gradientCover('rgba(90,200,255,0.85)', 'rgba(30,90,160,0.9)'), 'Neon Cadence', '@drillforge · 120K'),
    tile(gemCover, 'Aurora Plume', 'Uniform · ◈1,800'),
    tile(gradientCover('rgba(255,170,90,0.85)', 'rgba(150,60,30,0.9)'), 'Phoenix', '@marchlab · 89K'),
    tile(gradientCover('rgba(70,200,150,0.85)', 'rgba(20,90,80,0.9)'), 'Tidal', 'Blue Coast · 31K'),
  )));

  scroll.AddChild(sectionOf('Fresh in the shop', rowOf(
    tile(gradientCover('rgba(80,90,160,0.85)', 'rgba(30,30,70,0.9)'), 'Midnight Cadet', 'Uniform · ◈1,200'),
    tile(gradientCover('rgba(120,200,255,0.85)', 'rgba(20,70,120,0.9)'), 'Apex Dome', 'Stadium · ◈2,400'),
    tile(gradientCover('rgba(255,200,90,0.85)', 'rgba(150,90,20,0.9)'), 'Brass Empire', 'Music · ◈800'),
    tile(gradientCover('rgba(190,140,250,0.85)', 'rgba(90,50,150,0.9)'), 'Fluid Forms', 'Drill Pack · ◈1,000'),
  )));

  // Shared room light (glass sheen + lights the 3D). Light fog. NO DOF (blurs UI).
  canvas.SetLight({ Pos: [240, 120, 380], Color: [1, 0.98, 0.95], Strength: 1.2, Radius: 1300 });
  canvas.SetFog({ Color: [0.05, 0.05, 0.06], Start: 1200, Range: 700, Density: 1 });
  canvas.SetDof({ FocusDepth: 643, FocusRange: 400, Strength: 0 });

  canvas.Start();
  requestAnimationFrame(() => { el.dataset.ready = 'true'; });
  let _lf = performance.now(); let _ema = 0;
  canvas.RegisterPostFrame(() => {
    const now = performance.now(); const dt = now - _lf; _lf = now;
    _ema = _ema === 0 ? dt : _ema * 0.9 + dt * 0.1;
    (window as unknown as Record<string, unknown>).__jaui_framems = _ema;
  });
}
