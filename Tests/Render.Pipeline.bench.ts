import { bench, describe } from 'vitest';
import { Jiv } from '../src/Jiv/Jiv';
import { SolveLayout } from '../src/Layout/Layout.Solver';
import { ComputeIntrinsicSizes, CascadePointScale } from '../src/Layout/Layout.Intrinsic';
import { ResolveStyle, SEED_CONTEXT } from '../src/Core/Style.Resolver';
import { Spring } from '../src/Animation/Spring';
import { JivStyleAnimator } from '../src/Jiv/Jiv.StyleAnimator';
import { AnimationManager } from '../src/Animation/Animation.Manager';

// ─── Tree builders ───

const buildTree = (depth: number, branching: number, opts?: { glass?: boolean }): Jiv => {
  const root = new Jiv({
    Width: 1200, Height: 800,
    Style: { Material: opts?.glass ? 'LiquidGlass' : 'None' },
    Layout: { Display: 'Flex', Direction: 'Column' },
  });
  const populate = (parent: Jiv, d: number) => {
    if (d <= 0) return;
    for (let i = 0; i < branching; i++) {
      const child = new Jiv({
        Style: { Material: i % 3 === 0 && opts?.glass ? 'LiquidGlass' : 'None' },
        Layout: { Display: 'Flex', Direction: d % 2 === 0 ? 'Row' : 'Column' },
        ChildLayout: { FlexGrow: '1' },
      });
      parent.Children.push(child);
      child.Parent = parent;
      populate(child, d - 1);
    }
  };
  populate(root, depth);
  return root;
};

const countNodes = (node: Jiv): number => {
  let n = 1;
  for (const c of node.Children) n += countNodes(c);
  return n;
};

// ~50 nodes (realistic small UI)
const tree50 = buildTree(3, 3);
// ~200 nodes (realistic complex UI)
const tree200 = buildTree(4, 4);
// ~500 nodes (stress test)
const tree500 = buildTree(5, 4);

const viewport = { Width: 1200, Height: 800 };

// ─── Layout Solver ───

describe('Layout Solver', () => {
  bench(`SolveLayout ~${countNodes(tree50)} nodes`, () => {
    SolveLayout(tree50, viewport);
  });

  bench(`SolveLayout ~${countNodes(tree200)} nodes`, () => {
    SolveLayout(tree200, viewport);
  });

  bench(`SolveLayout ~${countNodes(tree500)} nodes`, () => {
    SolveLayout(tree500, viewport);
  });
});

// ─── Intrinsic Sizes ───

describe('Intrinsic Sizes', () => {
  bench(`ComputeIntrinsicSizes ~${countNodes(tree200)} nodes`, () => {
    ComputeIntrinsicSizes(tree200, viewport);
  });
});

// ─── Tree Walks (simulates _collectNonGlass / _collectGlass pattern) ───

const walkCollect = (node: Jiv, offsetX: number, offsetY: number, pred: (j: Jiv) => boolean): number => {
  let count = 0;
  if (node.Width > 0 && node.Height > 0 && pred(node)) count++;
  const scrollX = node.ScrollX || 0;
  const scrollY = node.ScrollY || 0;
  const dx = offsetX + scrollX;
  const dy = offsetY + scrollY;
  for (const child of node.Children) count += walkCollect(child, dx, dy, pred);
  return count;
};

const hasGlassAncestor = (node: Jiv): boolean => {
  let p = node.Parent;
  while (p) {
    if (p.RenderStyle.Material === 'LiquidGlass') return true;
    p = p.Parent;
  }
  return false;
};

const glassTree = buildTree(4, 4, { glass: true });
SolveLayout(glassTree, viewport);

describe('Tree Walks (per-frame collectors)', () => {
  bench(`collectNonGlass ~${countNodes(tree200)} nodes`, () => {
    walkCollect(tree200, 0, 0, j => j.RenderStyle.Material === 'None' && !hasGlassAncestor(j));
  });

  bench(`collectGlass ~${countNodes(glassTree)} nodes`, () => {
    walkCollect(glassTree, 0, 0, j => j.RenderStyle.Material === 'LiquidGlass');
  });

  bench(`hasGlassAncestor walk-to-root x${countNodes(glassTree)}`, () => {
    const check = (node: Jiv): void => {
      hasGlassAncestor(node);
      for (const c of node.Children) check(c);
    };
    check(glassTree);
  });

  bench('8 collector walks (full frame sim)', () => {
    const pred1 = (j: Jiv) => j.RenderStyle.Material === 'None';
    const pred2 = (j: Jiv) => j.RenderStyle.Material === 'LiquidGlass';
    // Simulates the 8 tree walks per frame found in Jaui._render
    walkCollect(tree200, 0, 0, pred1);   // collectNonGlass
    walkCollect(tree200, 0, 0, pred2);   // collectGlass
    walkCollect(tree200, 0, 0, pred1);   // collectNonGlassUnderGlass
    walkCollect(tree200, 0, 0, () => true); // collectTextNonGlass
    walkCollect(tree200, 0, 0, () => true); // collectTextGlass
    walkCollect(tree200, 0, 0, () => true); // scanFrostBlur
    walkCollect(tree200, 0, 0, () => true); // maxProgressiveBlurSigma
    walkCollect(tree200, 0, 0, () => true); // processTextTransitions
  });
});

// ─── Per-node allocation patterns ───

describe('Per-node Allocations', () => {
  bench('tuple allocation [dx, dy] per node x200', () => {
    for (let i = 0; i < 200; i++) {
      const _offset: [number, number] = [i * 0.5, i * 0.3];
      void _offset;
    }
  });

  bench('object allocation {Width, Height} per call', () => {
    for (let i = 0; i < 200; i++) {
      const _vp = { Width: 1200, Height: 800 };
      void _vp;
    }
  });

  bench('reuse scratch tuple per node x200', () => {
    const scratch: [number, number] = [0, 0];
    for (let i = 0; i < 200; i++) {
      scratch[0] = i * 0.5;
      scratch[1] = i * 0.3;
    }
  });
});

// ─── Style Resolution ───

describe('Style Resolution', () => {
  const style = tree200.Style;

  bench('ResolveStyle single node', () => {
    ResolveStyle(style, SEED_CONTEXT);
  });

  bench(`ResolveStyle full tree ~${countNodes(tree200)} nodes`, () => {
    const resolve = (node: Jiv) => {
      ResolveStyle(node.Style, node.ResolveCtx ?? SEED_CONTEXT);
      for (const c of node.Children) resolve(c);
    };
    resolve(tree200);
  });
});

// ─── Spring Animation ───

describe('Spring Animation', () => {
  bench('Spring.Step x1000', () => {
    const s = new Spring(0, 170, 26, 1);
    s.Target = 100;
    for (let i = 0; i < 1000; i++) s.Step(0.016);
  });

  const springs100 = Array.from({ length: 100 }, () => {
    const s = new Spring(0, 170, 26, 1);
    s.Target = 100;
    return s;
  });

  bench('100 springs x1 tick (per-frame budget)', () => {
    for (const s of springs100) s.Step(0.016);
  });
});

// ─── Style Animator (full per-Jiv tick) ───

describe('Style Animator', () => {
  const jiv = new Jiv({
    Width: 200, Height: 100,
    Style: { Material: 'LiquidGlass', Background: 'rgba(255,255,255,0.2)' },
  });
  jiv.ResolveCtx = SEED_CONTEXT;
  const animator = new JivStyleAnimator(jiv);
  jiv.Style.Opacity = '0.5';

  bench('JivStyleAnimator.Tick (single node, ~60 springs)', () => {
    animator.Tick(0.016);
  });

  const nodes = Array.from({ length: 50 }, () => {
    const j = new Jiv({ Width: 100, Height: 50, Style: { Material: 'LiquidGlass' } });
    j.ResolveCtx = SEED_CONTEXT;
    return { jiv: j, animator: new JivStyleAnimator(j) };
  });

  bench('50 JivStyleAnimator.Tick (simulates full-scene animation)', () => {
    for (const n of nodes) n.animator.Tick(0.016);
  });
});

// ─── Dirty Checking ───

describe('Dirty Checking', () => {
  const hasDirtyLayout = (node: Jiv): boolean => {
    if (node.Dirty & 1) return true;
    for (const c of node.Children) { if (hasDirtyLayout(c)) return true; }
    return false;
  };

  const hasDirtyText = (node: Jiv): boolean => {
    if (node.Dirty & 2) return true;
    for (const c of node.Children) { if (hasDirtyText(c)) return true; }
    return false;
  };

  bench(`hasDirtyLayout ~${countNodes(tree200)} nodes (clean tree)`, () => {
    hasDirtyLayout(tree200);
  });

  bench(`hasDirtyText ~${countNodes(tree200)} nodes (clean tree)`, () => {
    hasDirtyText(tree200);
  });
});
