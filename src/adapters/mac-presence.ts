import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { UNREAD } from '../plugins/presence.js';
import type { PresenceReading } from '../plugins/types.js';

const run = promisify(execFile);
const READ_TIMEOUT_MS = 3_000;
const BUILD_TIMEOUT_MS = 180_000;

const HELPER_SOURCE = String.raw`import CoreAudio
import CoreGraphics
import CoreMediaIO
import Foundation

func idleSeconds() -> Int? {
  guard let any = CGEventType(rawValue: ~0) else { return nil }
  let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
  return seconds.isFinite && seconds >= 0 ? Int(seconds) : nil
}

func screenLocked() -> Bool? {
  guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return nil }
  return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func displayAsleep() -> Bool? {
  var count: UInt32 = 0
  guard CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 else { return nil }
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  guard CGGetOnlineDisplayList(count, &ids, &count) == .success else { return nil }
  return ids.prefix(Int(count)).allSatisfy { CGDisplayIsAsleep($0) != 0 }
}

func cameraInUse() -> Bool? {
  var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices), mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal), mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
  var size: UInt32 = 0
  guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &size) == 0 else { return nil }
  var devices = [CMIOObjectID](repeating: 0, count: Int(size) / MemoryLayout<CMIOObjectID>.size)
  var used: UInt32 = 0
  guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, size, &used, &devices) == 0 else { return nil }
  address.mSelector = CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere)
  for device in devices {
    var running: UInt32 = 0
    var got: UInt32 = 0
    if CMIOObjectGetPropertyData(device, &address, 0, nil, UInt32(MemoryLayout<UInt32>.size), &got, &running) == 0, running != 0 { return true }
  }
  return false
}

func audioObjects(_ selector: AudioObjectPropertySelector) -> [AudioObjectID]? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return nil }
  return ids
}

func audioFlag(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> Bool? {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var value: UInt32 = 0
  var size = UInt32(MemoryLayout<UInt32>.size)
  return AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr ? value != 0 : nil
}

func micInUse() -> Bool? {
  guard let processes = audioObjects(kAudioHardwarePropertyProcessObjectList) else { return nil }
  var known = processes.isEmpty
  for process in processes {
    guard let input = audioFlag(process, kAudioProcessPropertyIsRunningInput) else { continue }
    if input { return true }
    known = true
  }
  return known ? false : nil
}

func json(_ value: Any?) -> String {
  switch value {
  case let bool as Bool: return bool ? "true" : "false"
  case let int as Int: return String(int)
  default: return "null"
  }
}

while readLine() != nil {
  print("{\"idle_s\":\(json(idleSeconds())),\"locked\":\(json(screenLocked())),\"display_asleep\":\(json(displayAsleep())),\"camera\":\(json(cameraInUse())),\"mic\":\(json(micInUse()))}")
  fflush(stdout)
}
`;

export class MacPresence {
  private helper: Promise<string | null> | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private waiting: Array<(line: string | null) => void> = [];

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = console.error,
  ) {}

  async read(): Promise<PresenceReading> {
    const bin = await (this.helper ??= this.build());
    const line = bin ? await this.ask(bin) : null;
    const reading = line ? parseReading(line) : null;
    return reading ?? { ...UNREAD, idle_s: await hidIdleSeconds() };
  }

  close(): void {
    this.child?.kill();
    this.child = null;
  }

  private async build(): Promise<string | null> {
    const bin = join(this.dir, `presence-${createHash('sha256').update(HELPER_SOURCE).digest('hex').slice(0, 12)}`);
    if (existsSync(bin)) return bin;
    try {
      const developer = (await run('xcode-select', ['-p'], { timeout: 5_000 })).stdout.trim();
      if (!developer || !existsSync(developer)) throw new Error('no developer tools');
      await mkdir(this.dir, { recursive: true });
      const source = `${bin}.swift`;
      await writeFile(source, HELPER_SOURCE);
      await run('xcrun', ['swiftc', '-O', source, '-o', `${bin}.tmp`], { timeout: BUILD_TIMEOUT_MS });
      await rename(`${bin}.tmp`, bin);
      return bin;
    } catch (error) {
      this.log(`presence: could not build the helper (${(error as Error).message.split('\n')[0]}), so only idle time is read, from ioreg`);
      return null;
    }
  }

  private ask(bin: string): Promise<string | null> {
    if (!this.child) this.child = this.spawnHelper(bin);
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = this.waiting.filter((waiter) => waiter !== done);
        if (this.child === child) this.close();
        resolve(null);
      }, READ_TIMEOUT_MS);
      const done = (line: string | null) => {
        clearTimeout(timer);
        resolve(line);
      };
      this.waiting.push(done);
      child.stdin.write('\n');
    });
  }

  private spawnHelper(bin: string): ChildProcessWithoutNullStreams {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    const flush = () => {
      if (this.child === child) this.child = null;
      for (const waiter of this.waiting.splice(0)) waiter(null);
    };
    createInterface({ input: child.stdout }).on('line', (line) => this.waiting.shift()?.(line));
    child.on('error', flush).on('exit', flush);
    child.stdin.on('error', flush);
    child.stderr.resume();
    return child;
  }
}

export function parseReading(line: string): PresenceReading | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  const flag = (key: string) => (typeof value[key] === 'boolean' ? (value[key] as boolean) : null);
  const idle = value.idle_s;
  return {
    idle_s: typeof idle === 'number' && Number.isFinite(idle) && idle >= 0 ? Math.floor(idle) : null,
    locked: flag('locked'),
    display_asleep: flag('display_asleep'),
    camera: flag('camera'),
    mic: flag('mic'),
  };
}

async function hidIdleSeconds(): Promise<number | null> {
  try {
    const text = (await run('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { timeout: 5_000 })).stdout;
    const ns = /"HIDIdleTime" = (\d+)/.exec(text)?.[1];
    return ns ? Math.floor(Number(ns) / 1e9) : null;
  } catch {
    return null;
  }
}
