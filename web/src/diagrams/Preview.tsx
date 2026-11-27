import { useEffect, useRef, useState } from 'react';
import type { DiagramInfo } from '../../../src/api/types.js';
import { client } from '../lib.js';
import { lightTheme } from './data.js';

export function Preview({ diagram, className = 'lib-thumb' }: { diagram: Pick<DiagramInfo, 'id' | 'updated' | 'elementCount'>; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const art = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && setSeen(true), { rootMargin: '200px' });
    observer.observe(box.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!seen || !diagram.elementCount) return;
    let cancelled = false;
    renderPreview(diagram.id).then(
      (svg) => cancelled || art.current?.replaceChildren(svg),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [seen, diagram.id, diagram.updated, diagram.elementCount]);
  return (
    <span ref={box} className={className} aria-hidden="true">
      {diagram.elementCount ? <span ref={art} className="lib-art" /> : <span className="lib-blank">Empty</span>}
    </span>
  );
}

async function renderPreview(id: string): Promise<SVGSVGElement> {
  const [{ exportToSvg }, scene] = await Promise.all([import('@excalidraw/excalidraw'), client.diagramScene(id)]);
  const svg = await exportToSvg({
    elements: scene.elements as never,
    files: scene.files as never,
    appState: { exportBackground: false, exportWithDarkMode: !lightTheme() },
    exportPadding: 12,
    skipInliningFonts: true,
  });
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  return svg;
}
