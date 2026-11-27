import type { ReactNode } from 'react';
import type { BlockLayout, Canvas, Feedback, View } from '../../../src/canvas/types.js';

export interface BlockProps<B = any> {
  block: B;
  layout: BlockLayout | undefined;
  answer: unknown;
  setAnswer: (value: unknown) => void;
  locked: boolean;
  fb: Feedback | undefined;
  view: View;
  setView: (view: View) => void;
  point: (node: string) => void;
  pointed: string | null;
  q: { k: number; n: number } | null;
  canvas: Canvas;
  request: () => void;
}

// One renderer per block kind; label names the kind in the "Go deeper" summary.
export interface BlockView {
  label: string;
  Render: (props: BlockProps) => ReactNode;
}
