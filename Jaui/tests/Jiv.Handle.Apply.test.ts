import { describe, expect, it } from 'vitest';
import { JivHandle } from '../src/Worker/Jiv.Handle';
import type { MainBridge } from '../src/Worker/Bridge.Main';
import type { JivApplyOpts } from '../src/Worker/Bridge.Types';

// An apply ships only the bags the worker does not already hold.
const handle = (): { Node: JivHandle; Sent: JivApplyOpts[] } => {
  const sent: JivApplyOpts[] = [];
  const bridge = {
    Enqueue: (op: { K: string; Opts?: JivApplyOpts }) => { if (op.K === 'apply') sent.push(op.Opts!); },
    SetHitHandlers: () => {},
    ClearHitHandlers: () => {},
  } as unknown as MainBridge;
  return { Node: new JivHandle(bridge, 7), Sent: sent };
};
const opts = (width: string, animations: Array<Record<string, unknown>> = []): JivApplyOpts => ({
  Style: { Background: 'rgb(255, 255, 255)', Shadow: [{ Blur: 4 }] },
  Layout: {},
  ChildLayout: { Width: width },
  TextStyle: {},
  Classes: ['HeroDotFill'],
  Animations: animations,
  AnimationTable: { Pulse: { Stops: [] } },
});

describe('JivHandle.Apply', () => {
  it('sends every bag first, then only the ones that changed', () => {
    const { Node, Sent } = handle();
    Node.Apply(opts('10%'));
    expect(Object.keys(Sent[0]).sort()).toEqual(['AnimationTable', 'Animations', 'ChildLayout', 'Classes', 'Layout', 'Style', 'TextStyle']);
    Node.Apply(opts('11%'));
    expect(Sent[1]).toEqual({ ChildLayout: { Width: '11%' } });
    Node.Apply(opts('11%'));
    expect(Sent[2]).toEqual({});
  });

  it('always sends a running animation set, which restarts on every apply that carries it', () => {
    const { Node, Sent } = handle();
    const live = [{ Kind: 'Named', Name: 'Pulse' }];
    Node.Apply(opts('10%', live));
    Node.Apply(opts('10%', live));
    expect(Object.keys(Sent[1]).sort()).toEqual(['AnimationTable', 'Animations']);
  });

  it('sends every bag again after an imperative write has flushed', async () => {
    const { Node, Sent } = handle();
    Node.Apply(opts('10%'));
    Node.Style.Opacity = '0.5';
    await Promise.resolve();
    Node.Apply(opts('10%'));
    expect(Object.keys(Sent[2]).sort()).toEqual(['AnimationTable', 'Animations', 'ChildLayout', 'Classes', 'Layout', 'Style', 'TextStyle']);
  });
});
