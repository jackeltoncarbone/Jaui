import { describe, expect, it } from 'vitest';
import { JivHandle } from '../src/Worker/Jiv.Handle';
import type { MainBridge } from '../src/Worker/Bridge.Main';
import type { JivApplyOpts } from '../src/Worker/Bridge.Types';

const handle = (): { Node: JivHandle; Sent: JivApplyOpts[] } => {
  const sent: JivApplyOpts[] = [];
  const bridge = {
    Enqueue: (op: { K: string; Opts?: JivApplyOpts }) => { if (op.K === 'apply') sent.push(op.Opts!); },
    SetHitHandlers: () => {},
    ClearHitHandlers: () => {},
  } as unknown as MainBridge;
  return { Node: new JivHandle(bridge, 7), Sent: sent };
};

// The worker applies only the state names it is sent, so a state turned off must be SENT as off.
describe('JivHandle.SetState', () => {
  it('tells the worker when a state turns off, not only when it turns on', async () => {
    const { Node, Sent } = handle();
    Node.SetState('Editing', true);
    await Promise.resolve();
    expect(Sent.at(-1)?.States?.['Editing']).toBe(true);
    Node.SetState('Editing', false);
    await Promise.resolve();
    expect(Sent.at(-1)?.States).toHaveProperty('Editing', false);
  });

  it('reads an off state as off', () => {
    const { Node } = handle();
    Node.SetState('Disabled', true);
    Node.SetState('Disabled', false);
    expect(Node.Disabled).toBe(false);
  });
});
