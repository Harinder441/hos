export type PreflightStatus = 'ok' | 'warn' | 'fail';

export interface PreflightRow {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  fix?: string;
}

export interface PreflightResult {
  ok: boolean;
  rows: PreflightRow[];
}

export interface PreflightOptions {
  port?: number;
  dataDir?: string;
  hosRoot?: string;
  claudeBin?: string;
}

export interface RunResult {
  ok: boolean;
  found: boolean;
  stdout: string;
  stderr: string;
}

export interface PreflightMachine {
  platform: string;
  arch: string;
  nodeVersion: string;
  home: string;
  env: Record<string, string | undefined>;
  run(bin: string, args: string[], options?: { env?: Record<string, string> }): RunResult;
  portFree(port: number): Promise<boolean>;
  freeBytes(dir: string): number | null;
}

export const MIN_NODE_MAJOR: number;
export const MIN_FREE_BYTES: number;
export const LOW_FREE_BYTES: number;
export const DEFAULT_PORT: number;
export function claudeEnv(env?: Record<string, string | undefined>): Record<string, string>;
export function bundledClaudeIn(hosRoot: string, platform?: string, arch?: string): string | null;
export function preflight(options?: PreflightOptions, machine?: PreflightMachine): Promise<PreflightResult>;
export function thisMachine(): PreflightMachine;
export function preflightText(result: PreflightResult): string;
export function preflightMain(args: string[]): Promise<number>;
