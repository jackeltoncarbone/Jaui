import type { LayoutResult, FlexDirection, FlexWrap, JustifyContent, AlignItems, AlignContent } from './Layout.Types';
import { Jath } from '../Core/Jath';

// ─── Solver Input Types ───

export interface FlexContainer {
  Width: number;
  Height: number;
  Direction: FlexDirection;
  Wrap: FlexWrap;
  Justify: JustifyContent;
  Align: AlignItems;
  AlignContent: AlignContent;
  Gap: number;
  RowGap: number;
  ColumnGap: number;
  Padding: [number, number, number, number]; // top, right, bottom, left
}

export interface FlexChild {
  Index: number;
  Order: number;
  FlexGrow: number;
  FlexShrink: number;
  FlexBasis: number | 'Auto';
  AlignSelf: AlignItems | 'Auto';
  Margin: [number | 'Auto', number | 'Auto', number | 'Auto', number | 'Auto'];
  Width: number | 'Auto';
  Height: number | 'Auto';
  MinWidth: number;
  MaxWidth: number;
  MinHeight: number;
  MaxHeight: number;
}

// ─── Internal Types ───

interface _FlexItem {
  Child: FlexChild;
  MainSize: number;
  CrossSize: number;
  MainPos: number;
  CrossPos: number;
  MarginBefore: number;
  MarginAfter: number;
  MarginCrossBefore: number;
  MarginCrossAfter: number;
  Frozen: boolean;
}

interface _FlexLine {
  Items: _FlexItem[];
  MainSize: number;
  CrossSize: number;
  CrossPos: number;
}

// ─── Axis Helpers ───

const _isHorizontal = (dir: FlexDirection): boolean =>
  dir === 'Row' || dir === 'RowReverse';

const _isReversed = (dir: FlexDirection): boolean =>
  dir === 'RowReverse' || dir === 'ColumnReverse';

const _mainGap = (c: FlexContainer): number => {
  if (_isHorizontal(c.Direction)) return c.ColumnGap || c.Gap;
  return c.RowGap || c.Gap;
};

const _crossGap = (c: FlexContainer): number => {
  if (_isHorizontal(c.Direction)) return c.RowGap || c.Gap;
  return c.ColumnGap || c.Gap;
};

const _mainSpace = (c: FlexContainer): number => {
  const [pt, pr, pb, pl] = c.Padding;
  if (_isHorizontal(c.Direction)) return c.Width - pl - pr;
  return c.Height - pt - pb;
};

const _crossSpace = (c: FlexContainer): number => {
  const [pt, pr, pb, pl] = c.Padding;
  if (_isHorizontal(c.Direction)) return c.Height - pt - pb;
  return c.Width - pl - pr;
};

const _resolveMargin = (m: number | 'Auto'): number =>
  m === 'Auto' ? 0 : m;

const _isAutoMargin = (m: number | 'Auto'): boolean => m === 'Auto';

// ─── Solver ───

export const SolveFlex = (container: FlexContainer, children: FlexChild[]): LayoutResult[] => {
  if (children.length === 0) return [];

  const horiz = _isHorizontal(container.Direction);
  const reversed = _isReversed(container.Direction);
  const mainAvailable = _mainSpace(container);
  const crossAvailable = _crossSpace(container);
  const gap = _mainGap(container);

  // Sort by Order (stable)
  const sorted = children.map((c, i) => ({ child: c, originalIndex: i }));
  sorted.sort((a, b) => a.child.Order - b.child.Order);

  // Build flex items
  const items: _FlexItem[] = sorted.map(({ child }) => {
    // Resolve margins: main axis = left/right for Row, top/bottom for Column
    const [mt, mr, mb, ml] = child.Margin;
    const marginBefore = horiz ? _resolveMargin(ml) : _resolveMargin(mt);
    const marginAfter = horiz ? _resolveMargin(mr) : _resolveMargin(mb);
    const marginCrossBefore = horiz ? _resolveMargin(mt) : _resolveMargin(ml);
    const marginCrossAfter = horiz ? _resolveMargin(mb) : _resolveMargin(mr);

    // Hypothetical main size
    let mainSize: number;
    if (child.FlexBasis !== 'Auto') {
      mainSize = child.FlexBasis;
    } else {
      const explicitMain = horiz ? child.Width : child.Height;
      mainSize = explicitMain === 'Auto' ? 0 : explicitMain;
    }

    const minMain = horiz ? child.MinWidth : child.MinHeight;
    const maxMain = horiz ? child.MaxWidth : child.MaxHeight;
    mainSize = Jath.Clamp(mainSize, minMain, maxMain);

    return {
      Child: child,
      MainSize: mainSize,
      CrossSize: 0,
      MainPos: 0,
      CrossPos: 0,
      MarginBefore: marginBefore,
      MarginAfter: marginAfter,
      MarginCrossBefore: marginCrossBefore,
      MarginCrossAfter: marginCrossAfter,
      Frozen: false,
    };
  });

  // Collect into lines
  const lines = _collectLines(items, container.Wrap, mainAvailable, gap);

  // For each line: distribute space, position on main axis
  for (const line of lines) {
    _distributeMainSpace(line, mainAvailable, gap, container, horiz);
    _resolveCrossSizes(line, crossAvailable, container.Align, horiz);
  }

  // Position lines on cross axis
  _positionLines(lines, crossAvailable, container.AlignContent, _crossGap(container));

  // Position items on cross axis within each line
  for (const line of lines) {
    _positionCrossAxis(line, container.Align);
  }

  // Handle auto margins on main axis
  for (const line of lines) {
    _resolveAutoMargins(line, mainAvailable, gap, container, horiz);
  }

  // Position on main axis
  for (const line of lines) {
    _positionMainAxis(line, mainAvailable, gap, container.Justify);
  }

  // Reverse if needed
  if (reversed) {
    for (const line of lines) {
      for (const item of line.Items) {
        item.MainPos = mainAvailable - item.MainPos - item.MainSize;
      }
    }
  }

  if (container.Wrap === 'WrapReverse') {
    for (const line of lines) {
      for (const item of line.Items) {
        item.CrossPos = crossAvailable - item.CrossPos - item.CrossSize;
      }
    }
  }

  // Map back to X/Y/Width/Height
  const [pt, _pr, _pb, pl] = container.Padding;
  const results: LayoutResult[] = new Array(children.length);

  for (const line of lines) {
    for (const item of line.Items) {
      const mainPos = item.MainPos;
      const crossPos = item.CrossPos;

      const result: LayoutResult = horiz
        ? { X: pl + mainPos, Y: pt + crossPos, Width: item.MainSize, Height: item.CrossSize }
        : { X: pl + crossPos, Y: pt + mainPos, Width: item.CrossSize, Height: item.MainSize };

      // Map back to original index
      results[sorted.find(s => s.child === item.Child)!.originalIndex] = result;
    }
  }

  return results;
};

// ─── Line Collection ───

const _collectLines = (
  items: _FlexItem[],
  wrap: FlexWrap,
  mainAvailable: number,
  gap: number,
): _FlexLine[] => {
  if (wrap === 'NoWrap' || items.length === 0) {
    const mainSize = items.reduce((sum, item) => sum + item.MainSize + item.MarginBefore + item.MarginAfter, 0)
      + Math.max(0, items.length - 1) * gap;
    return [{ Items: items, MainSize: mainSize, CrossSize: 0, CrossPos: 0 }];
  }

  const lines: _FlexLine[] = [];
  let currentItems: _FlexItem[] = [];
  let currentMainSize = 0;

  for (const item of items) {
    const itemTotal = item.MainSize + item.MarginBefore + item.MarginAfter;
    const gapBefore = currentItems.length > 0 ? gap : 0;

    if (currentItems.length > 0 && currentMainSize + gapBefore + itemTotal > mainAvailable) {
      lines.push({ Items: currentItems, MainSize: currentMainSize, CrossSize: 0, CrossPos: 0 });
      currentItems = [item];
      currentMainSize = itemTotal;
    } else {
      currentItems.push(item);
      currentMainSize += gapBefore + itemTotal;
    }
  }

  if (currentItems.length > 0) {
    lines.push({ Items: currentItems, MainSize: currentMainSize, CrossSize: 0, CrossPos: 0 });
  }

  return lines;
};

// ─── Main Axis Space Distribution ───

const _distributeMainSpace = (
  line: _FlexLine,
  mainAvailable: number,
  gap: number,
  _container: FlexContainer,
  horiz: boolean,
): void => {
  const items = line.Items;
  const totalGaps = Math.max(0, items.length - 1) * gap;
  const totalMargins = items.reduce((sum, item) => sum + item.MarginBefore + item.MarginAfter, 0);
  const totalHypothetical = items.reduce((sum, item) => sum + item.MainSize, 0);
  let freeSpace = mainAvailable - totalGaps - totalMargins - totalHypothetical;

  if (freeSpace > 0) {
    // Grow
    _distributeGrow(items, freeSpace, horiz);
  } else if (freeSpace < 0) {
    // Shrink
    _distributeShrink(items, -freeSpace, horiz);
  }

  // Recalculate line main size
  line.MainSize = items.reduce((sum, item) => sum + item.MainSize + item.MarginBefore + item.MarginAfter, 0)
    + totalGaps;
};

const _distributeGrow = (items: _FlexItem[], freeSpace: number, horiz: boolean): void => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const growable = items.filter(i => !i.Frozen && i.Child.FlexGrow > 0);
    if (growable.length === 0) break;

    const totalGrow = growable.reduce((sum, i) => sum + i.Child.FlexGrow, 0);
    if (totalGrow === 0) break;

    let remainingSpace = freeSpace;
    let frozeAny = false;

    for (const item of growable) {
      const share = (item.Child.FlexGrow / totalGrow) * freeSpace;
      const newSize = item.MainSize + share;
      const maxMain = horiz ? item.Child.MaxWidth : item.Child.MaxHeight;

      if (newSize > maxMain) {
        remainingSpace -= (maxMain - item.MainSize);
        item.MainSize = maxMain;
        item.Frozen = true;
        frozeAny = true;
      }
    }

    if (!frozeAny) {
      // No clamping needed — distribute normally
      for (const item of growable) {
        const share = (item.Child.FlexGrow / totalGrow) * freeSpace;
        item.MainSize += share;
      }
      break;
    }

    freeSpace = remainingSpace;
  }
};

const _distributeShrink = (items: _FlexItem[], overflow: number, horiz: boolean): void => {
  for (let iteration = 0; iteration < 10; iteration++) {
    const shrinkable = items.filter(i => !i.Frozen && i.Child.FlexShrink > 0);
    if (shrinkable.length === 0) break;

    const totalWeighted = shrinkable.reduce((sum, i) => sum + i.Child.FlexShrink * i.MainSize, 0);
    if (totalWeighted === 0) break;

    let remainingOverflow = overflow;
    let frozeAny = false;

    for (const item of shrinkable) {
      const weight = item.Child.FlexShrink * item.MainSize;
      const reduction = (weight / totalWeighted) * overflow;
      const newSize = item.MainSize - reduction;
      const minMain = horiz ? item.Child.MinWidth : item.Child.MinHeight;

      if (newSize < minMain) {
        remainingOverflow -= (item.MainSize - minMain);
        item.MainSize = minMain;
        item.Frozen = true;
        frozeAny = true;
      }
    }

    if (!frozeAny) {
      for (const item of shrinkable) {
        const weight = item.Child.FlexShrink * item.MainSize;
        const reduction = (weight / totalWeighted) * overflow;
        item.MainSize -= reduction;
      }
      break;
    }

    overflow = remainingOverflow;
  }
};

// ─── Cross Size Resolution ───

const _resolveCrossSizes = (
  line: _FlexLine,
  crossAvailable: number,
  align: AlignItems,
  horiz: boolean,
): void => {
  for (const item of line.Items) {
    const explicitCross = horiz ? item.Child.Height : item.Child.Width;
    const minCross = horiz ? item.Child.MinHeight : item.Child.MinWidth;
    const maxCross = horiz ? item.Child.MaxHeight : item.Child.MaxWidth;
    const selfAlign = item.Child.AlignSelf === 'Auto' ? align : item.Child.AlignSelf;

    if (explicitCross !== 'Auto') {
      item.CrossSize = Jath.Clamp(explicitCross, minCross, maxCross);
    } else if (selfAlign === 'Stretch') {
      const available = crossAvailable - item.MarginCrossBefore - item.MarginCrossAfter;
      item.CrossSize = Jath.Clamp(Math.max(0, available), minCross, maxCross);
    } else {
      item.CrossSize = Jath.Clamp(0, minCross, maxCross);
    }
  }

  // Line cross size = max of all items (including their cross margins)
  line.CrossSize = 0;
  for (const item of line.Items) {
    const total = item.CrossSize + item.MarginCrossBefore + item.MarginCrossAfter;
    if (total > line.CrossSize) line.CrossSize = total;
  }
};

// ─── Auto Margins ───

const _resolveAutoMargins = (
  line: _FlexLine,
  mainAvailable: number,
  gap: number,
  _container: FlexContainer,
  horiz: boolean,
): void => {
  const items = line.Items;
  const totalGaps = Math.max(0, items.length - 1) * gap;
  const totalUsed = items.reduce((sum, item) =>
    sum + item.MainSize + item.MarginBefore + item.MarginAfter, 0) + totalGaps;
  const freeSpace = Math.max(0, mainAvailable - totalUsed);

  for (const item of items) {
    const [mt, mr, mb, ml] = item.Child.Margin;
    const mainBefore = horiz ? ml : mt;
    const mainAfter = horiz ? mr : mb;
    const autoCount = (_isAutoMargin(mainBefore) ? 1 : 0) + (_isAutoMargin(mainAfter) ? 1 : 0);

    if (autoCount > 0) {
      // Count total auto margins in this line for proportional distribution
      let totalAutoInLine = 0;
      for (const i of items) {
        const [imt, imr, imb, iml] = i.Child.Margin;
        const iBefore = horiz ? iml : imt;
        const iAfter = horiz ? imr : imb;
        if (_isAutoMargin(iBefore)) totalAutoInLine++;
        if (_isAutoMargin(iAfter)) totalAutoInLine++;
      }

      const perAuto = totalAutoInLine > 0 ? freeSpace / totalAutoInLine : 0;
      if (_isAutoMargin(mainBefore)) item.MarginBefore = perAuto;
      if (_isAutoMargin(mainAfter)) item.MarginAfter = perAuto;
    }
  }
};

// ─── Main Axis Positioning ───

const _positionMainAxis = (
  line: _FlexLine,
  mainAvailable: number,
  gap: number,
  justify: JustifyContent,
): void => {
  const items = line.Items;
  const totalUsed = items.reduce((sum, item) =>
    sum + item.MainSize + item.MarginBefore + item.MarginAfter, 0);

  // Check if any auto margins exist — if so, skip JustifyContent
  const hasAutoMargins = items.some(item => {
    const [mt, mr, mb, ml] = item.Child.Margin;
    return ml === 'Auto' || mr === 'Auto' || mt === 'Auto' || mb === 'Auto';
  });

  const totalGaps = Math.max(0, items.length - 1) * gap;
  const freeSpace = mainAvailable - totalUsed - totalGaps;

  let pos: number;
  let itemGap: number;

  if (hasAutoMargins) {
    // Auto margins already consumed the free space
    pos = 0;
    itemGap = gap;
  } else {
    switch (justify) {
      case 'Start':
        pos = 0;
        itemGap = gap;
        break;
      case 'End':
        pos = freeSpace;
        itemGap = gap;
        break;
      case 'Center':
        pos = freeSpace / 2;
        itemGap = gap;
        break;
      case 'SpaceBetween':
        pos = 0;
        itemGap = items.length > 1 ? (freeSpace + totalGaps) / (items.length - 1) : gap;
        break;
      case 'SpaceAround': {
        const around = items.length > 0 ? (freeSpace + totalGaps) / items.length : 0;
        pos = around / 2;
        itemGap = around;
        break;
      }
      case 'SpaceEvenly': {
        const even = items.length > 0 ? (freeSpace + totalGaps) / (items.length + 1) : 0;
        pos = even;
        itemGap = even;
        break;
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    pos += item.MarginBefore;
    item.MainPos = pos;
    pos += item.MainSize + item.MarginAfter;
    if (i < items.length - 1) pos += itemGap;
  }
};

// ─── Cross Axis Positioning ───

const _positionCrossAxis = (line: _FlexLine, align: AlignItems): void => {
  for (const item of line.Items) {
    const selfAlign = item.Child.AlignSelf === 'Auto' ? align : item.Child.AlignSelf;
    const availableCross = line.CrossSize - item.MarginCrossBefore - item.MarginCrossAfter;

    switch (selfAlign) {
      case 'Start':
      case 'Stretch':
        item.CrossPos = line.CrossPos + item.MarginCrossBefore;
        break;
      case 'End':
        item.CrossPos = line.CrossPos + item.MarginCrossBefore + availableCross - item.CrossSize;
        break;
      case 'Center':
        item.CrossPos = line.CrossPos + item.MarginCrossBefore + (availableCross - item.CrossSize) / 2;
        break;
    }
  }
};

// ─── Line Positioning (AlignContent) ───

const _positionLines = (
  lines: _FlexLine[],
  crossAvailable: number,
  alignContent: AlignContent,
  crossGap: number,
): void => {
  if (lines.length === 0) return;

  // Single line: stretch to fill, position at 0. Stretch only ever grows
  // the line — never shrinks it below what the items need (otherwise a
  // child's cross-axis margin gets clipped by a too-small container).
  if (lines.length === 1) {
    lines[0].CrossPos = 0;
    if (alignContent === 'Stretch' && crossAvailable > lines[0].CrossSize) {
      lines[0].CrossSize = crossAvailable;
    }
    return;
  }

  const totalLineSize = lines.reduce((sum, l) => sum + l.CrossSize, 0);
  const totalGaps = (lines.length - 1) * crossGap;
  const freeSpace = crossAvailable - totalLineSize - totalGaps;

  let pos: number;
  let lineGap: number;

  switch (alignContent) {
    case 'Start':
      pos = 0;
      lineGap = crossGap;
      break;
    case 'End':
      pos = freeSpace;
      lineGap = crossGap;
      break;
    case 'Center':
      pos = freeSpace / 2;
      lineGap = crossGap;
      break;
    case 'Stretch': {
      pos = 0;
      lineGap = crossGap;
      const extra = freeSpace / lines.length;
      for (const line of lines) line.CrossSize += extra;
      break;
    }
    case 'SpaceBetween':
      pos = 0;
      lineGap = lines.length > 1 ? (freeSpace + totalGaps) / (lines.length - 1) : crossGap;
      break;
    case 'SpaceAround': {
      const around = (freeSpace + totalGaps) / lines.length;
      pos = around / 2;
      lineGap = around;
      break;
    }
    case 'SpaceEvenly': {
      const even = (freeSpace + totalGaps) / (lines.length + 1);
      pos = even;
      lineGap = even;
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    lines[i].CrossPos = pos;
    pos += lines[i].CrossSize;
    if (i < lines.length - 1) pos += lineGap;
  }
};
