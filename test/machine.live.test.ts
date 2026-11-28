import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { MacMachine } from '../src/adapters/machine.js';

const macMachine = new MacMachine({ launchAgentPlist: '/nonexistent/dev.hos.daemon.plist', presenceDir: join(mkdtempSync(join(tmpdir(), 'hos-presence-')), 'presence') });

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

  test('the presence helper builds once and reads all five signals, then answers from the running helper', async () => {
    const first = await macMachine.presence();
    const started = Date.now();
    const second = await macMachine.presence();

    for (const reading of [first, second]) {
      expect(reading.idle_s).toEqual(expect.any(Number));
      for (const flag of [reading.locked, reading.display_asleep, reading.camera, reading.mic]) expect(typeof flag).toBe('boolean');
    }
    expect(Date.now() - started).toBeLessThan(500);
  }, 200_000);
});
