import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brainUpdate } from './brain-update.js';
import { defaultBrain, hosRoot } from './common.js';
import { adoptBrain } from './init.js';
import { linkHos, unlinkHos } from './link.js';
import { syncLines, syncSkills } from './skills.js';
import { validateBrain } from './validate.js';
import { versionLine } from './version.js';

const USAGE = {
  validate: 'usage: hos validate [--brain <dir>]',
  skills: 'usage: hos skills sync [--brain <dir>] [--dry-run]',
  init: 'usage: hos init --adopt <dir> [--starter <git url or path>] [--origin <your private repo url>] [--name <name>] [--timezone <IANA zone>]',
  brain: 'usage: hos brain update [--brain <dir>]',
  doctor: 'usage: hos doctor --preflight [--json] [--port <port>] [--data-dir <dir>] [--claude-bin <path>]\n  machine checks before install; the full doctor is Settings → Doctor in the app, or GET /api/doctor',
  link: 'usage: hos link [--bin-dir <dir>]   (default ~/.local/bin)',
  unlink: 'usage: hos unlink [--bin-dir <dir>]',
};

export const CLI_COMMANDS = ['--version', '-v', 'version', 'validate', 'skills', 'init', 'brain', 'doctor', 'link', 'unlink'];

export async function runCli(argv: string[]): Promise<number | null> {
  const [command, ...rest] = argv;
  if (!command || !CLI_COMMANDS.includes(command)) return null;
  try {
    if (command === 'doctor') return await doctor(rest);
    return run(command, rest);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
}

function run(command: string, rest: string[]): number {
  const print = (result: { ok: boolean; lines: string[] }) => {
    for (const line of result.lines) (line.startsWith('FAIL') ? console.error : console.log)(line);
    return result.ok ? 0 : 1;
  };
  const brainOption = { brain: { type: 'string' as const } };
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(versionLine());
    return 0;
  }
  if (command === 'link' || command === 'unlink') {
    const { values } = parseArgs({ args: rest, options: { 'bin-dir': { type: 'string' } } });
    const options = values['bin-dir'] ? { binDir: values['bin-dir'] } : {};
    return print(command === 'link' ? linkHos(options) : unlinkHos(options));
  }
  if (command === 'validate') {
    const { values } = parseArgs({ args: rest, options: brainOption });
    return print(validateBrain(resolve(values.brain ?? defaultBrain())));
  }
  if (command === 'skills') {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { ...brainOption, 'dry-run': { type: 'boolean', default: false } } });
    if (positionals[0] !== 'sync') return usage(USAGE.skills);
    const dryRun = values['dry-run'];
    return print({ ok: true, lines: syncLines(syncSkills(resolve(values.brain ?? defaultBrain()), { dryRun }), dryRun) });
  }
  if (command === 'init') {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        adopt: { type: 'boolean', default: false },
        starter: { type: 'string' },
        origin: { type: 'string' },
        name: { type: 'string' },
        timezone: { type: 'string' },
      },
    });
    if (!values.adopt || positionals.length !== 1) return usage(USAGE.init);
    return print(
      adoptBrain({
        dir: positionals[0]!,
        ...(values.starter ? { starter: values.starter } : {}),
        ...(values.origin ? { origin: values.origin } : {}),
        ...(values.name !== undefined ? { name: values.name } : {}),
        ...(values.timezone ? { timezone: values.timezone } : {}),
      }),
    );
  }
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: brainOption });
  if (positionals[0] !== 'update') return usage(USAGE.brain);
  return print(brainUpdate(values.brain ?? defaultBrain()));
}

async function doctor(rest: string[]): Promise<number> {
  if (rest[0] !== '--preflight') return usage(USAGE.doctor);
  const file = pathToFileURL(join(hosRoot(), 'install', 'preflight.mjs')).href;
  const { preflightMain } = (await import(file)) as { preflightMain(args: string[]): Promise<number> };
  return preflightMain(rest.slice(1));
}

function usage(text: string): number {
  console.error(text);
  return 2;
}
