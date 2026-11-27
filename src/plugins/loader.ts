import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Clock } from '../adapters/clock.js';
import { hosVersion } from '../computers.js';
import { HosError } from '../core.js';
import { AcpAgentRuntime } from '../harnesses/acp/runtime.js';
import { TOOL_NAMES } from '../harnesses/tools.js';
import { canonical, insideAny } from '../policy.js';
import { snagFiles } from '../snags/files.js';
import { Sources, sourceProblem } from './registry.js';
import { PLUGIN_API_VERSION, type PluginDatabase, type PluginHost, type PluginModule, type SnagRecord, type Source } from './types.js';

export const PLUGIN_TIMEOUT_MS = 10_000;

export interface PluginEntry {
  file: string;
  options: Record<string, unknown>;
}

export interface PluginReport {
  file: string;
  name: string | null;
  builtIn: boolean;
  provides: string[];
  problem: string | null;
}

export interface LoadContext {
  dataDir: string;
  brainDir: string | null;
  clock: Clock;
  pluginsDir?: string;
  timeoutMs?: number;
  log?: (line: string) => void;
  snagReached?: (pendingRef: number, record: SnagRecord) => void;
}

export interface Loaded {
  sources: Sources;
  reports: PluginReport[];
  close(): Promise<void>;
}

// Built-in sources keep snag files in their own folder so they never touch a plug-in's S<n> folders.
export function snagSpace(plugin: string, builtIn: boolean): string | null {
  return builtIn ? plugin : null;
}

export function pluginsDir(brainDir: string): string {
  return join(brainDir, 'hos', 'plugins');
}

export async function loadSources(entries: PluginEntry[], ctx: LoadContext, builtIns: PluginModule[] = []): Promise<Loaded> {
  const sources = new Sources();
  const reports: PluginReport[] = [];
  const databases: Database.Database[] = [];
  const log = ctx.log ?? ((line: string) => console.error(line));
  const timeoutMs = ctx.timeoutMs ?? PLUGIN_TIMEOUT_MS;

  const register = async (plugin: PluginModule, file: string, options: Record<string, unknown>, builtIn: boolean): Promise<PluginReport> => {
    const report: PluginReport = { file, name: plugin.name, builtIn, provides: [], problem: null };
    const provided: Source[] = [];
    const opened: Database.Database[] = [];
    let open = true;
    const dataDir = join(ctx.dataDir, 'plugins', plugin.name);
    const host: PluginHost = {
      apiVersion: PLUGIN_API_VERSION,
      hosVersion: hosVersion(),
      name: plugin.name,
      options,
      dataDir,
      brainDir: ctx.brainDir,
      provide(source) {
        if (!open) throw new Error(`${plugin.name} called provide() after its register() finished`);
        const problem = sourceProblem(source);
        if (problem) throw new Error(problem);
        provided.push(source);
      },
      log: (line) => log(`plugin ${plugin.name}: ${line}`),
      now: () => ctx.clock.now(),
      setTimeout: (fn, ms) => ctx.clock.setTimeout(fn, ms),
      sqlite(name) {
        if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error(`sqlite() takes a plain file name, not ${name}`);
        mkdirSync(dataDir, { recursive: true });
        const db = new Database(join(dataDir, name));
        db.pragma('journal_mode = WAL');
        opened.push(db);
        return db as unknown as PluginDatabase;
      },
      fail: (status, message) => new HosError(status, message),
      snagFiles: snagFiles(ctx.brainDir, log, snagSpace(plugin.name, builtIn)),
      snagReached: (pendingRef, record) => ctx.snagReached?.(pendingRef, record),
      acp: (id, config) => new AcpAgentRuntime(id, config),
      tools: TOOL_NAMES,
    };
    try {
      await within(Promise.resolve(plugin.register(host)), timeoutMs, `${plugin.name} did not finish register() within ${timeoutMs / 1000} s`);
    } catch (error) {
      report.problem = (error as Error).message;
    } finally {
      open = false;
    }
    if (report.problem) {
      for (const source of provided) await Promise.resolve(source.close?.()).catch(() => {});
      for (const db of opened) if (db.open) db.close();
      return report;
    }
    const skipped: string[] = [];
    for (const source of provided) {
      const clash = sources.add(source, plugin.name, builtIn);
      if (clash) skipped.push(clash);
      else report.provides.push(source.kind);
    }
    if (skipped.length) report.problem = skipped.join('; ');
    databases.push(...opened);
    return report;
  };

  for (const plugin of builtIns) reports.push(await register(plugin, `built-in ${plugin.name}`, {}, true));

  const root = ctx.pluginsDir ?? (ctx.brainDir ? pluginsDir(ctx.brainDir) : null);
  for (const entry of entries) {
    const failed = (problem: string) => reports.push({ file: entry.file, name: null, builtIn: false, provides: [], problem });
    if (!root) {
      failed('hos has no brain, so it loads no plug-ins');
      continue;
    }
    const path = isAbsolute(entry.file) ? entry.file : resolve(root, entry.file);
    if (!insideAny([root], path) || canonical(path) === canonical(root)) {
      failed(`plug-in files must sit in ${root}, where hos asks you first before an agent changes them when your policy says so (approvals.plugin_edits)`);
      continue;
    }
    let plugin: PluginModule;
    try {
      const loaded = (await within(import(pathToFileURL(canonical(path)).href), timeoutMs, `loading took more than ${timeoutMs / 1000} s`)) as Record<string, unknown>;
      plugin = pluginShape((loaded.default ?? loaded) as Record<string, unknown>);
    } catch (error) {
      failed((error as Error).message);
      continue;
    }
    const taken = reports.find((r) => r.name === plugin.name);
    if (taken) {
      failed(`the plug-in name ${plugin.name} is already used by ${taken.file}`);
      continue;
    }
    reports.push(await register(plugin, entry.file, entry.options, false));
  }

  return {
    sources,
    reports,
    async close() {
      await sources.close();
      for (const db of databases) if (db.open) db.close();
    },
  };
}

function pluginShape(value: Record<string, unknown>): PluginModule {
  const { name, apiVersion, register } = value;
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error('a plug-in exports a name of lowercase letters, digits and dashes');
  if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion) || apiVersion < 1 || apiVersion > PLUGIN_API_VERSION) {
    throw new Error(`${name} is written for plug-in API ${String(apiVersion)}; this hos runs API ${PLUGIN_API_VERSION}`);
  }
  if (typeof register !== 'function') throw new Error(`${name} exports no register(host) function`);
  return { name, apiVersion, register: (register as PluginModule['register']).bind(value) };
}

function within<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
