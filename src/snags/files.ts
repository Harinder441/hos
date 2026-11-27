import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { unlinkedPath } from '../attachments.js';
import { HosError } from '../core.js';
import type { SnagFiles, SnagUpload } from '../plugins/types.js';

export function refLabel(ref: number): string {
  return ref < 0 ? `S?${-ref}` : `S${ref}`;
}

export function snagDir(brainDir: string, ref: number, space: string | null = null): string {
  return join(brainDir, '.context', 'snags', ...(space ? [space] : []), ref < 0 ? `pending-${-ref}` : `S${ref}`);
}

const NO_BRAIN = 'hos has no brain (start it with --brain), so there is nowhere to keep snag files';

export function snagFiles(brainDir: string | null, log: (line: string) => void, space: string | null = null): SnagFiles {
  const dir = (ref: number) => {
    if (!brainDir) throw new HosError(400, NO_BRAIN);
    return snagDir(brainDir, ref, space);
  };
  return {
    dir,
    async save(ref: number, files: SnagUpload[]) {
      if (!files.length) return;
      const target = dir(ref);
      if (!unlinkedPath(brainDir!, relative(brainDir!, target))) {
        throw new HosError(400, '.context/snags in the brain goes through a link; hos keeps snag files only in a real folder');
      }
      await mkdir(target, { recursive: true });
      for (const { name, bytes } of files) await writeFile(join(target, name), bytes);
    },
    async move(from: number, to: number) {
      if (!brainDir) return;
      const source = snagDir(brainDir, from, space);
      if (!existsSync(source)) return;
      const target = snagDir(brainDir, to, space);
      try {
        await mkdir(target, { recursive: true });
        for (const name of await readdir(source)) await rename(join(source, name), join(target, name));
        await rm(source, { recursive: true, force: true });
      } catch (error) {
        log(`snags: the files of ${refLabel(from)} stay in ${source}, moving them to ${target} failed: ${(error as Error).message}`);
      }
    },
    async remove(ref: number) {
      if (brainDir) await rm(snagDir(brainDir, ref, space), { recursive: true, force: true });
    },
  };
}
