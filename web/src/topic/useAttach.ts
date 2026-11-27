import { useState, type ClipboardEvent, type DragEvent } from 'react';
import type { DraftFile } from '../drafts.js';
import { client, errorText } from '../lib.js';
import { useComposer } from './catalog.js';

export function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}

export function useAttach(topicId: string, setPending: (next: (files: DraftFile[]) => DraftFile[]) => void, disabled = false) {
  const attach = (files: File[]) => {
    if (!files.length || disabled) return false;
    const added = files.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, name: file.name || 'pasted-image.png', file }));
    setPending((list) => [...list, ...added.map(({ key, name }) => ({ key, name }))]);
    for (const { key, name, file } of added) {
      readBase64(file)
        .then((data) => client.uploadAttachment(topicId, name, data))
        .then(
          (saved) => setPending((list) => list.map((p) => (p.key === key ? { ...p, name: saved.name, path: saved.path } : p))),
          (e: unknown) => setPending((list) => list.map((p) => (p.key === key ? { ...p, error: errorText(e) } : p))),
        );
    }
    return true;
  };
  return useFileInput(attach, disabled);
}

export function useFileInput(attach: (files: File[]) => boolean, disabled = false) {
  const composerConfig = useComposer();
  const [drop, setDrop] = useState(false);

  const onPaste = (e: ClipboardEvent) => {
    if (attach([...(e.clipboardData?.files ?? [])])) return e.preventDefault();
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (composerConfig && pasted.length > composerConfig.pasteAsFileChars && attach([new File([pasted], 'pasted-text.txt', { type: 'text/plain' })])) e.preventDefault();
  };
  const onDragOver = (e: DragEvent) => {
    if (disabled || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setDrop(true);
  };
  const onDragLeave = () => setDrop(false);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrop(false);
    attach([...(e.dataTransfer?.files ?? [])]);
  };

  return { drop, handlers: { onPaste, onDragOver, onDragLeave, onDrop } };
}
