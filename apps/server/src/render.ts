/**
 * Plan rendering (FLR-T-2.8). The worker's `renderPlanPng` draws a level of a document as a PNG;
 * until it is wired in, the API answers a render request with a clear 501 instead of a picture.
 */
export interface PlanRenderer {
  renderPlanPng(document: unknown, options: { readonly level?: string }): Promise<Uint8Array>;
}

export const RENDER_PENDING = 'rendering arrives with FLR-T-2.8';
export const RENDER_3D_PENDING = '3D rendering is not available yet: it arrives in Phase 7 (FLR-P-7)';
