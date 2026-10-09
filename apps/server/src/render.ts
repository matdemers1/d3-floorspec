/**
 * Plan rendering (FLR-T-2.8): the worker's `renderPlanPng` draws one level of a document as a PNG.
 * It runs in the api process for now — the worker has no job queue yet — behind this interface,
 * so moving it onto a queue later changes the wiring and nothing else. The plan is drawn with the
 * reader the api validates with everywhere (`OFFICIAL_READER`), never a core-only one, so a model
 * that requires an official extension draws as it validates.
 */
import { OFFICIAL_READER } from '@floorspec/engine';

export interface PlanRenderOptions {
  readonly level?: string;
  /** The document before a changeset: its changes are drawn ghosted over it. */
  readonly ghost?: { readonly before: object };
  /** Element IDs drawn in the accent colour — what an edit just created. */
  readonly highlight?: readonly string[];
  /** Pixels wide; the height follows the plan. */
  readonly width?: number;
  readonly theme?: 'light' | 'dark';
  /**
   * The bytes of the plan symbols its furniture and fixtures name (Core 12.6), by SHA-256: each is
   * drawn as its symbol; one without bytes is drawn as its kind's outline (FLR-T-12.24).
   */
  readonly symbols?: ReadonlyMap<string, Uint8Array>;
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
      return renderPlanPng(document, { ...options, reader: OFFICIAL_READER });
    },
  };
}
