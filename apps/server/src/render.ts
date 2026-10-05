/**
 * Plan rendering (FLR-T-2.8): the worker's `renderPlanPng` draws one level of a document as a PNG.
 * It runs in the api process for now — the worker has no job queue yet — behind this interface,
 * so moving it onto a queue later changes the wiring and nothing else.
 */
export interface PlanRenderOptions {
  readonly level?: string;
  /** The document before a changeset: its changes are drawn ghosted over it. */
  readonly ghost?: { readonly before: object };
  /** Element IDs drawn in the accent colour — what an edit just created. */
  readonly highlight?: readonly string[];
  /** Pixels wide; the height follows the plan. */
  readonly width?: number;
  readonly theme?: 'light' | 'dark';
}

export interface PlanRenderer {
  renderPlanPng(document: object, options: PlanRenderOptions): Promise<Uint8Array>;
}

export const RENDER_PENDING = 'rendering arrives with FLR-T-2.8';

/** The worker's renderer, in-process. Imported lazily so a server that never renders never loads resvg. */
export function workerRenderer(): PlanRenderer {
  return {
    async renderPlanPng(document, options) {
      const { renderPlanPng } = await import('@d3-floorspec/worker/render');
      return renderPlanPng(document, options);
    },
  };
}
