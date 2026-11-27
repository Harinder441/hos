import { describe, expect, test } from 'vitest';
import { MacMachine } from '../src/adapters/machine.js';

const macMachine = new MacMachine({ launchAgentPlist: '/nonexistent/dev.hos.daemon.plist' });

describe.skipIf(!process.env.HOS_LIVE_MACHINE)('live contract: Mac memory, thermal and battery sampling (read-only)', () => {
  test('sysctl and pmset give a reading in the shape the fake machine plays', async () => {
    const sample = await macMachine.sample();

    expect(['normal', 'warn', 'critical']).toContain(sample.memory);
    expect(typeof sample.thermalWarning).toBe('boolean');
    expect(sample.battery).toEqual({ percent: expect.any(Number), onBattery: expect.any(Boolean) });
  });

  test('boot time and the setup facts come back in the shape the fake machine plays, without reading any token', async () => {
    const booted = await macMachine.bootedAt();
    const setup = await macMachine.setup();

    expect(booted).toBeLessThan(Date.now());
    expect(['set', 'unset', 'unknown']).toContain(setup.chargeLimit);
    expect(setup.claude).toEqual({ loggedIn: expect.any(Boolean), plan: expect.toBeOneOf([expect.any(String), null]) });
    expect(setup.launchAgent).toBe(false);
  }, 20_000);
});
