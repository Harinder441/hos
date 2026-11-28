import type { Machine, MachineSample, MachineSetup } from '../adapters/machine.js';
import type { PresenceReading } from '../plugins/types.js';

export class FakeMachine implements Machine {
  current: MachineSample = { memory: 'normal', thermalWarning: false, battery: { percent: 100, onBattery: false } };
  booted = Date.parse('2025-12-31T23:00:00Z');
  awake = false;
  facts: MachineSetup = {
    chargeLimit: 'set',
    claude: { loggedIn: true, plan: 'team' },
    launchAgent: true,
    browser: true,
  };

  reading: PresenceReading | Error = { idle_s: 3, locked: false, display_asleep: false, camera: false, mic: false };
  presence?: () => Promise<PresenceReading> = async () => {
    if (this.reading instanceof Error) throw this.reading;
    return this.reading;
  };

  async sample(): Promise<MachineSample> {
    return this.current;
  }

  async bootedAt(): Promise<number | null> {
    return this.booted;
  }

  keepAwake(): () => void {
    this.awake = true;
    return () => {
      this.awake = false;
    };
  }

  async setup(): Promise<MachineSetup> {
    return this.facts;
  }
}
