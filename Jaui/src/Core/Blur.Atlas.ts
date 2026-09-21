import {
  BaseDownsampleFactor, PresamplePlanFor, PyramidDepth, ResolveRegionRect, ChainBytes, CHAIN_BUDGET_BYTES,
  MAX_LEVELS, type BackdropRect, type RegionRect,
} from './BlurPass';

/**
 * THE ATLAS DECISION: may a frame's backdrop builds be issued TOGETHER, and what does that save?
 *
 * A pyramid build is a chain of render passes, each one a destination bind and therefore, on a
 * tile-based GPU behind ANGLE Metal, its own render command encoder with its own fixed cost. The
 * ledger's controlled four-cell prices `glass-grid`'s forty builds at 276 us each with the draw
 * count held IDENTICAL, so ~82% of the pyramid cost is that fixed per-pass overhead and not
 * shading. An ATLAS attacks it directly: build every member's level `i` into one target, one slot
 * each, one bind per level instead of one bind per level per member, so `N x L` encoders become
 * `L` while every slot holds exactly the texels that member's own pyramid holds today.
 *
 * THIS FILE IS THE PLANNER AND THERE IS NO ATLAS BUILD BEHIND IT, and that is the finding rather
 * than an omission — the same shape, and for the same reason, as `PlanBackdropUnion`, which has
 * lived unwired in `BlurPass.ts` since the union lane disproved its own brief.
 *
 * WHY. An atlas removes the UNION's blocker and keeps the union's OTHER one.
 *
 *  - Removed: the union saves in proportion to how much the member regions OVERLAP, so it wants a
 *    pitch below a region's own width, and `PyramidUnion.Finding.md` section 2 shows that pulling
 *    against the separation law until the union is worth at most 1.12x anywhere it is legal. An
 *    atlas has no overlap requirement at all. Its slots are disjoint by construction, its FILL is
 *    exactly today's, and it is worth its full `(N-1) x L` encoders wherever it may run.
 *  - Kept: the separation law itself. The encoder saving IS the hoisting. Passes can only share an
 *    encoder if they are issued together, and issuing them together moves every member's build to
 *    ONE scene state — which is precisely the composition `?blur-phased` already measured at
 *    34,830 px (0.85%, max delta 12): a card no longer refracts its earlier neighbour's glass in
 *    the overlap band. There is no arrangement of an atlas that batches the passes and leaves the
 *    scene states apart; a texture layout cannot undo a dependency in time.
 *
 * So on `glass-grid` — the scene the whole performance phase is measured on — `PlanBackdropAtlas`
 * returns null: JwiftGlass's fill sample margin is 64.75 device px against a 40 px gutter, every
 * card's region reaches 24.75 px into its neighbour's box, and with the 16pt drop shadow the law
 * asks for ~97 px of gap where the scene ships 40. Every run is a run of one. `Blur.Atlas.test.ts`
 * is that arithmetic, and it is the arithmetic anyone re-opening this question needs first.
 */

/** Render PASSES one `Blur` + `GenerateOutputMipmap` issues for a resolved rect at (k, depth,
 *  maxLod), counted with the SAME loops those two run rather than from a closed form — the
 *  discipline `PyramidFill` keeps, and for the same reason: this is the currency the atlas decision
 *  trades in, and a count one hop out mis-prices every build in the frame.
 *
 *  A pass is a DESTINATION BIND. Blits are counted apart from draws because `blitFramebuffer`
 *  between two attachments is its own encoder and not a draw: `Encoders` is the number to reason
 *  about, `Draws` (Pre + Down + Up + MipDraws) is what the harness's `drawCalls` column sees.
 *
 *  THE NUMBER THIS CORRECTS. The atlas brief assumed "~15-20 passes per build, so forty builds is
 *  600-800 encoders per render". A `glass-grid` fill build is k=1, depth=2, maxLod=0: two DOWN, two
 *  UP, and NO mip chain at all — `maxLod <= 0` takes `_generateOutputMipmap`'s first branch, which
 *  is `DisableMipmap()` and a return. FOUR passes, not fifteen; forty builds are 160 encoders, not
 *  600-800. The four-cell's 276 us per build stands either way, so what moves is the price of one
 *  encoder: ~69 us, not ~15-20. */
export const PyramidPasses = (
  rectW: number, rectH: number, k: number, depth: number, maxLod?: number,
): { Pre: number; Down: number; Up: number; MipDraws: number; Blits: number; Encoders: number } => {
  // Sharp-root mode (`Blur`'s `radius <= 0` branch): one 1-tap copy into level 0 and nothing else.
  if (depth <= 0) return { Pre: 1, Down: 0, Up: 0, MipDraws: 0, Blits: 0, Encoders: 1 };

  let w = rectW, h = rectH, pre = 0;
  for (let s = k; s > 1; s >>= 1) {
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
    pre++;
  }
  // `_generateOutputMipmap` runs against level 0, which is the rect AFTER the pre-downsample.
  let mipDraws = 0;
  if (maxLod === undefined || maxLod > 0) {
    const stopLevel = maxLod !== undefined
      ? Math.min(MAX_LEVELS - 1, Math.max(1, Math.ceil(maxLod) + 1))
      : MAX_LEVELS - 1;
    let sw = w, sh = h;
    for (let i = 1; i <= stopLevel; i++) {
      const nw = Math.max(1, Math.floor(sw / 2));
      const nh = Math.max(1, Math.floor(sh / 2));
      if (nw === sw && nh === sh) break;
      sw = nw; sh = nh;
      mipDraws++;
    }
  }
  return {
    Pre: pre, Down: depth, Up: depth, MipDraws: mipDraws, Blits: mipDraws,
    Encoders: pre + depth + depth + mipDraws * 2,
  };
};

/** One surface a frame would build a pyramid for, **in the order the walk builds them**.
 *
 *  `Paint` is the contract that makes the separation law checkable, and it is wider than the node's
 *  box: it is every device px painted between THIS member's build and the NEXT member's build —
 *  this surface's own body, its rim, its drop shadow, and anything the walk paints in between that
 *  is not a member at all. Folding the interlopers into the preceding member's rect is what lets
 *  the planner ask one question per pair instead of carrying the whole walk. A caller that passes
 *  only the glass boxes is asserting that nothing else painted there, and
 *  `PyramidUnion.Finding.md` section 1 records that exact assertion being wrong once already:
 *  `Jaui.ts`'s shipped dirty-rect rule pushes a footprint for glass and backdrop-filter nodes only,
 *  which is sound for the SHARED pyramid (taken before the walk's first surface) and false for
 *  anything taken part way through. */
export interface BackdropAtlasMember {
  /** The rect the pyramid is built over — `GlassBlurPlan.Region`, device px, y=0 at TOP. */
  Region: BackdropRect;
  /** Everything painted between this member's build and the next one's. Same frame as `Region`. */
  Paint: BackdropRect;
}

/** Where one member's level 0 sits inside its atlas, in atlas texels. `YBottom` counts from the
 *  BOTTOM, like `RegionRect`, because that is the axis every pass draws in. */
export interface AtlasSlot { X: number; YBottom: number; W: number; H: number }

/** One set of members that may be built together as a single atlas. */
export interface BackdropAtlasGroup {
  /** Indices into the planner's `members`, ascending and CONTIGUOUS. */
  Members: number[];
  /** One per member, in the same order. */
  Slots: AtlasSlot[];
  AtlasW: number;
  AtlasH: number;
  /** `ChainBytes` of the atlas's own level chain. */
  Bytes: number;
  /** Render encoders the group issues as ONE atlas, and as the separate builds it replaces. */
  Encoders: number;
  SoloEncoders: number;
}

export interface BackdropAtlasPlan {
  K: number;
  Depth: number;
  Phase: number;
  /** Groups of two or more. A frame may legitimately have several. */
  Groups: BackdropAtlasGroup[];
  /** Members no group could take. They build exactly as they do today. */
  Solo: number;
  /** Encoders the whole plan removes from the frame. */
  EncodersSaved: number;
}

/** Ceilings an atlas has to fit inside. `MaxTexture` is `MAX_TEXTURE_SIZE` — an atlas is ONE
 *  texture, and a single row of twenty 568-wide slots is 11,360 px, past the 8192 a conservative
 *  WebGL2 implementation guarantees. `BudgetBytes` is the blur pass's own residency ceiling: an
 *  atlas is one chain whose level 0 is the SUM of its slots, so it is charged like any other. */
export interface AtlasLimits { MaxTexture: number; BudgetBytes: number }
export const ATLAS_LIMITS_DEFAULT: AtlasLimits = { MaxTexture: 8192, BudgetBytes: CHAIN_BUDGET_BYTES };

/** What a WIRED atlas runs under, and why it is not `CHAIN_BUDGET_BYTES`.
 *
 *  `glass-grid`'s twenty cards at dpr 2 pack into a fills atlas of 1704x3052 (33.06 MB of chain)
 *  and a rims atlas of 1440x2436 (22.30 MB): 55.37 MB, against a shipped budget of 48 that admits
 *  ONE of the two. So the atlas carries its own ceiling, exactly as `?blur-phased` carried one to
 *  hold twenty chains at once -- and it REFUSES rather than evicts when a plan does not fit,
 *  because an evicting pool reallocates whole textures mid-frame and that thrash would be read as
 *  the atlas's own cost.
 *
 *  64 MB is the two atlases plus room for a handful of solo builds beside them, and not more: the
 *  number is a residency ceiling that has to be crossable by a scene bigger than the one it was
 *  sized for, so that the refusal fires and says so instead of the pool quietly thrashing.
 *
 *  THE PHONE. The same twenty cards at dpr 3 are 2.25x the texels: ~74 MB for the pair, past this
 *  ceiling. `PlanBackdropAtlas` then SPLITS the run -- the greedy extend stops at the last member
 *  that still fits and the rest form the next group -- so a phone gets two or three smaller
 *  atlases per phase instead of one, keeps most of the encoder saving, and never evicts. If even a
 *  pair does not fit, a member is solo and builds exactly as it does today. */
export const ATLAS_BUDGET_BYTES = 64 * 1024 * 1024;
export const ATLAS_LIMITS_WIRED: AtlasLimits = { MaxTexture: 8192, BudgetBytes: ATLAS_BUDGET_BYTES };

/** Rect overlap in device px, half-open on both axes. */
export const RectsOverlap = (a: BackdropRect, b: BackdropRect): boolean =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * THE SEPARATION LAW, as code the pass owns rather than as a predicate rewritten in a test.
 *
 * May members `[first..last]` be built from ONE scene state — that is, may their builds be hoisted
 * to the point where the first of them builds today?
 *
 * A backdrop is not only a place, it is a TIME. The walk builds member j's pyramid from the scene
 * AS OF ITS OWN DRAW, so it contains everything painted before it, including the glass painted
 * before it. Batch j's build with i's and j no longer sees what i painted. The run is legal exactly
 * when no earlier member's paint lands inside a later member's sample region:
 *
 *     for all first <= i < j <= last:   Paint_i does not overlap Region_j
 *
 * CONTIGUITY is not a convenience, it is the rest of the argument. Everything the walk paints
 * BEFORE the run is on the scene in both orders and everything after it is in neither, so a
 * contiguous run is the only shape whose hoist touches nothing outside itself. A run that skipped a
 * member would hoist its later members past that member's draw, which is the same violation from
 * the other side — and it is why a checkerboard over a grid does not rescue this: taking cards 1,
 * 3, 5 leaves card 2 drawn between card 1's hoisted build and card 3's, and card 2's paint is
 * inside card 3's region by the same 24.75 px.
 */
export const AtlasRunIsLegal = (
  members: readonly BackdropAtlasMember[], first: number, last: number,
): boolean => {
  for (let j = first + 1; j <= last; j++) {
    for (let i = first; i < j; i++) {
      if (RectsOverlap(members[i].Paint, members[j].Region)) return false;
    }
  }
  return true;
};

/** Lay slots out on the `phase` grid, in member order, shelf by shelf.
 *
 *  Every slot origin and every extent is a multiple of `phase`, which is the whole texel argument:
 *  level i of a slot then sits at `origin / 2^i`, no slot straddles a texel at any level the chain
 *  uses, and one halving of the atlas is a halving of every slot at once. That is what makes an
 *  atlas level a texel-exact SUB-GRID of the standalone level it replaces — the same crop argument
 *  `ResolveRegionRect` makes for one region against the canvas-sized pyramid.
 *
 *  Member ORDER is kept rather than sorted by height, so slot k belongs to member k and a test can
 *  read the packing. The cost is wasted area on a ragged shelf, which is storage and not fill:
 *  nothing draws into the gaps and, under the edge contract below, nothing samples them.
 *
 *  Returns null when the pack does not fit `MaxTexture` on either axis. */
export const PackAtlasSlots = (
  rects: readonly { W: number; H: number }[], phase: number, limits: AtlasLimits,
): { Slots: AtlasSlot[]; AtlasW: number; AtlasH: number } | null => {
  if (rects.length === 0) return null;
  let area = 0, widest = 0;
  for (const r of rects) {
    if (r.W % phase !== 0 || r.H % phase !== 0) return null;
    area += r.W * r.H;
    if (r.W > widest) widest = r.W;
  }
  // A square-ish sheet keeps both axes under MAX_TEXTURE_SIZE for as long as anything can, and a
  // shelf never starts narrower than the widest slot or that slot could never place.
  const target = Math.max(widest, Math.ceil(Math.ceil(Math.sqrt(area)) / phase) * phase);
  if (target > limits.MaxTexture) return null;

  const placed: AtlasSlot[] = [];
  let x = 0, shelfY = 0, shelfH = 0, atlasW = 0;
  for (const r of rects) {
    if (x !== 0 && x + r.W > target) { shelfY += shelfH; x = 0; shelfH = 0; }
    placed.push({ X: x, YBottom: shelfY, W: r.W, H: r.H });
    x += r.W;
    if (x > atlasW) atlasW = x;
    if (r.H > shelfH) shelfH = r.H;
  }
  const atlasH = shelfY + shelfH;
  if (atlasW > limits.MaxTexture || atlasH > limits.MaxTexture) return null;
  // `YBottom` was filled top-down above; flip it into GL's axis, which is the axis every pass and
  // every consumer reads. Exact: both terms are multiples of `phase`.
  for (const s of placed) s.YBottom = atlasH - s.YBottom - s.H;
  return { Slots: placed, AtlasW: atlasW, AtlasH: atlasH };
};

/** One surface the walk is offering to an atlas, in the terms `GlassBlurPlan` already carries --
 *  so `Core/Jaui.ts` passes its plan straight in rather than copying six fields into a second
 *  shape that can drift away from the first. */
export interface AtlasCandidate {
  Region: BackdropRect;
  /** The frost sigma in device px. `k`, `depth` and the phase grid all come off it. */
  Radius: number;
  /** How deep a chain the CONSUMER can sample. */
  MaxLod: number;
  /** The node's own device-px AABB, y=0 at the TOP. */
  Px: number; Py: number; Pw: number; Ph: number;
  /** How far past that AABB the surface's own DRAW can tap the pyramid, in device px. */
  TapReach: number;
}

/**
 * MAY THIS SURFACE BE A SLOT? Four refusals, each of them something an atlas cannot represent,
 * and a refusal is a SOLO build -- which is today's engine, so being conservative here costs
 * nothing but the saving on that one surface.
 *
 * 1. `MaxLod > 0` opens a mip chain, and an atlas of mips would have to slot every mip level of
 *    every member (`GenerateOutputMipmap` into sub-rects of the atlas's own mip i). Not designed.
 *    On every scene the harness measures `MaxLod` is 0 -- the pyramid is built AT the panel's own
 *    frost sigma, so `frostReq` is 0 and the whole LOD boost with it -- so this fires for a
 *    `BorderFilter: Blur(n)` class and for nothing else today.
 * 2. `k > 1` needs the sigma-adaptive pre-downsample's ping-pong slotted too. Same answer, and
 *    `PyramidAtlas.Finding.md` section 6 names it as the third thing to check if a gate fails.
 * 3. A FULL-canvas region is the shared backdrop's shape, not a member's: it resolves to the
 *    identity map and there is nothing to relocate.
 * 4. THE REGION MUST CONTAIN THE CONSUMER'S OWN TAPS, and this is the one the finding's section 6
 *    did not name. A standalone pyramid is its own texture, so a tap that leaves the region is
 *    answered by CLAMP_TO_EDGE replicating the border texel. A SLOT has no border: the same tap
 *    reads whatever the packer put beside it. `Jiv.Panel.frag` is not this lane's to change and a
 *    gutter would need replication PASSES -- the thing the atlas exists to remove -- so the region
 *    has to contain every tap instead, and a member whose region does not is refused.
 *
 *    The reach is clipped to the canvas before the test, because a fragment outside the canvas is
 *    never rasterized: a draw quad that runs off the left edge cannot tap from there, so a region
 *    the canvas clamped at 0 is not short of anything. The test is against the RESOLVED rect --
 *    the slot's actual extent, which is the requested region snapped OUT to the phase grid -- so
 *    the few texels the snap adds count in the surface's favour, exactly as they do on the GPU.
 */
export const AtlasAdmitsMember = (
  c: AtlasCandidate, width: number, height: number, presample: boolean = false,
  gaussian: boolean = false,
): boolean => {
  if (c.Radius <= 0) return false;
  // `?glass-gaussian` and the atlas cannot both own how a member's backdrop is produced. The
  // atlas relocates the CHAIN's texels -- its slot grid, its `u_Slot` / `u_Clamp` and its
  // `PyramidPasses` all assume four hops into levels it packed -- and a Gaussian build has no
  // levels above 0 and no hops to pack. Refused here as well as by name in the flag block, on
  // this file's own principle: an admission rule that consults a different plan than the pass it
  // is planning for is the bug `BaseDownsampleFactor`'s module comment warns about.
  if (gaussian) return false;
  if (c.MaxLod > 0) return false;
  if (BaseDownsampleFactor(c.Radius, width, height, c.Region) !== 1) return false;
  // Refusal 2 again, asked of the plan the build will actually take. `?glass-presample` lifts
  // the area gate, and every small-region member this atlas exists for is exactly the shape the
  // gate was refusing -- so without this clause the arm would silently slot k=2 members into a
  // packer whose slot grid, whose `u_Slot`/`u_Clamp` and whose `PyramidPasses` all assume the
  // ping-pong is absent. Same answer as the k > 1 line above, for the same reason.
  if (presample && PresamplePlanFor(c.Radius, width, height, c.Region, 0) !== null) return false;
  const depth = PyramidDepth(c.Radius, 0);
  const rect = ResolveRegionRect(c.Region, width, height, 1 << depth);
  if (rect.Full) return false;
  const reach = c.TapReach;
  const left = Math.max(0, c.Px - reach);
  const right = Math.min(width, c.Px + c.Pw + reach);
  const top = Math.max(0, c.Py - reach);
  const bottom = Math.min(height, c.Py + c.Ph + reach);
  // `rect` counts y from the BOTTOM; `Py` counts from the top.
  return rect.X <= left && rect.X + rect.W >= right
    && rect.YBottom <= height - bottom && rect.YBottom + rect.H >= height - top;
};

/**
 * Plan the frame's backdrop builds as atlases.
 *
 * `IgnoreSeparation` WAIVES the law and plans the hoisted composition instead — the pixels of
 * `?blur-phased`, already measured at 34,830 px (0.85%) at max delta 12, mean 2.1. It is not a
 * fallback and nothing may arm it silently: it exists so the ruling Jack is being asked for has a
 * number beside it in the same units as everything else in the ledger. Under it, `glass-grid`'s
 * twenty fill builds become ONE atlas and its twenty rims another — 160 encoders to 8 — which is
 * the same 40 -> 2 collapse the union offers, at strictly LESS pixel cost (each slot keeps its own
 * CLAMP_TO_EDGE, so the union's second difference, a card's blur drawing on its neighbour's real
 * content instead of its own replicated border, does not arise) and at strictly more storage.
 *
 * What it does NOT decide, and neither did the union planner: whether the walk may hand these
 * members over in the first place. That is a question about draw order, and only the walk knows the
 * walk.
 */
export const PlanBackdropAtlas = (
  members: readonly BackdropAtlasMember[],
  width: number, height: number, radius: number,
  opts?: {
    IgnoreSeparation?: boolean; Limits?: AtlasLimits; MaxLod?: number; Presample?: boolean;
    Gaussian?: boolean;
  },
): BackdropAtlasPlan | null => {
  if (members.length < 2) return null;
  if (radius <= 0) return null;
  // Refused for the WHOLE plan rather than per member, for the reason `Presample` is three lines
  // below: one member taking a Gaussian and its neighbours taking the chain is a mixed backdrop
  // across a class this planner exists to keep uniform.
  if (opts?.Gaussian === true) return null;
  // `?glass-presample` and the atlas cannot both own a member's k. Refused for the whole plan
  // rather than per member, because one member re-basing and its neighbours not is a MIXED k
  // across the class, which this planner refuses three lines below for the union's own reason.
  if (opts?.Presample === true
    && PresamplePlanFor(radius, width, height, members[0].Region, 0) !== null) return null;
  const limits = opts?.Limits ?? ATLAS_LIMITS_DEFAULT;
  const ignore = opts?.IgnoreSeparation ?? false;

  // One k across the class, on the same terms as the union: k depends on the REGION as well as on
  // sigma, so two surfaces at one frost can genuinely land on different factors, and mixing them is
  // a resample rather than a crop.
  const k = BaseDownsampleFactor(radius, width, height, members[0].Region);
  for (let i = 1; i < members.length; i++) {
    if (BaseDownsampleFactor(radius, width, height, members[i].Region) !== k) return null;
  }
  const depth = PyramidDepth(radius / k, 0);
  const phase = k * (1 << depth);

  // A member whose extent the canvas edge clamped off the phase grid cannot be a SLOT: its levels
  // stop halving exactly and the sub-grid argument is gone. It disqualifies ITSELF and nothing
  // else, which is the one place an atlas is more forgiving than a union — slots are independent,
  // where a union's members all live inside one rect.
  const resolved: (RegionRect | null)[] = members.map((m) => {
    const rr = ResolveRegionRect(m.Region, width, height, phase);
    return rr.W % phase === 0 && rr.H % phase === 0 ? rr : null;
  });

  const groups: BackdropAtlasGroup[] = [];
  let solo = 0, saved = 0, i = 0;
  while (i < members.length) {
    if (resolved[i] === null) { solo++; i++; continue; }
    // Extend greedily while the law holds, the next member is slottable, and the pack still fits
    // both ceilings. Every candidate run is packed from scratch rather than incrementally, because
    // adding a slot can move the shelf target and therefore every origin after it.
    let last = i;
    let pack: ReturnType<typeof PackAtlasSlots> = null;
    for (let j = i; j < members.length; j++) {
      if (resolved[j] === null) break;
      if (!ignore && !AtlasRunIsLegal(members, i, j)) break;
      const rects: { W: number; H: number }[] = [];
      for (let m = i; m <= j; m++) rects.push({ W: resolved[m]!.W, H: resolved[m]!.H });
      const p = PackAtlasSlots(rects, phase, limits);
      if (p === null) break;
      if (ChainBytes(p.AtlasW, p.AtlasH) > limits.BudgetBytes) break;
      last = j; pack = p;
    }
    if (pack === null || last === i) { solo++; i++; continue; }

    const indices: number[] = [];
    let soloEncoders = 0;
    for (let j = i; j <= last; j++) {
      indices.push(j);
      soloEncoders += PyramidPasses(resolved[j]!.W, resolved[j]!.H, k, depth, opts?.MaxLod).Encoders;
    }
    const atlasEncoders = PyramidPasses(pack.AtlasW, pack.AtlasH, k, depth, opts?.MaxLod).Encoders;
    groups.push({
      Members: indices, Slots: pack.Slots, AtlasW: pack.AtlasW, AtlasH: pack.AtlasH,
      Bytes: ChainBytes(pack.AtlasW, pack.AtlasH),
      Encoders: atlasEncoders, SoloEncoders: soloEncoders,
    });
    saved += soloEncoders - atlasEncoders;
    i = last + 1;
  }

  if (groups.length === 0) return null;
  return { K: k, Depth: depth, Phase: phase, Groups: groups, Solo: solo, EncodersSaved: saved };
};
