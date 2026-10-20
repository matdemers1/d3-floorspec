import type { TourManifest } from '@floorspec/mesh';
import { api, ApiError } from '../../lib/api';

/**
 * What a tour's share link reaches (FLR-T-14.2): the tour's state — being made, with how far it has
 * got, or made, with its manifest — and each panorama and plan the manifest names.
 */

export type TourState =
  | { readonly status: 'queued' | 'rendering'; readonly panos: number; readonly done: number }
  | { readonly status: 'failed'; readonly panos: number; readonly cancelled: boolean }
  | { readonly status: 'done'; readonly panos: number; readonly manifest: TourManifest };

export type TourAnswer = { status: 'ok'; tour: TourState } | { status: 'gone'; reason: 'expired' | 'revoked' } | { status: 'missing' } | { status: 'failed'; message: string };

const base = (token: string) => `/api/share/${encodeURIComponent(token)}/tour`;

export async function fetchTour(token: string): Promise<TourAnswer> {
  try {
    return { status: 'ok', tour: await api.get<TourState>(base(token)) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { status: 'missing' };
      if (error.status === 410) {
        const reason = (error.body as { reason?: string } | undefined)?.reason;
        return reason === undefined ? { status: 'failed', message: 'This tour’s panoramas are no longer kept.' } : { status: 'gone', reason: reason === 'expired' ? 'expired' : 'revoked' };
      }
      return { status: 'failed', message: error.message };
    }
    return { status: 'failed', message: 'The server did not answer.' };
  }
}

/** Where a file of the tour is: a panorama or a plan. */
export const tourFile = (token: string, path: string): string => `${base(token)}/${encodeURIComponent(path)}`;
