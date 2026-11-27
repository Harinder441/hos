export const DOCS_PROMPT_FILES: string[];
export function sha256(data: string | Buffer): string;
export function installUrl(repo: string, tag: string): string;
export function promptText(repo: string, tag: string, hash: string): string;
export function writePrompt(text: string, repo: string, tag: string, hash: string): string;
export function release(options: { root: string; tag: string; out: string; repo?: string }): { hash: string; tagged: boolean; lines: string[] };
export function writeSums(out: string): void;
