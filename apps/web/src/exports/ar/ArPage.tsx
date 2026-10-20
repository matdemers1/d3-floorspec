import './ar.css';
import { useEffect, useState } from 'react';
import { EmptyState, Spinner } from '@d3cloud/ui';
import { Download } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { arFragment, quickLook } from './quicklook';
import type { ArScale } from '../api';

/**
 * The page an AR model's link opens on a phone (FLR-T-14.3; the board's "AR Quick Look on the lot"):
 * anybody with the link, no account. On an iPhone or iPad one tap opens the house in AR Quick Look —
 * at true scale to stand on the lot (no pinching it smaller), or on a table at 1:50; anywhere else
 * the .usdz downloads. While the model is still being made, the page waits for it.
 */

type ArState =
  | { status: 'queued' | 'making' | 'failed'; scale: ArScale; project: string }
  | { status: 'done'; scale: ArScale; project: string; name: string; bytes: number | null; file: string };

type Phase = { status: 'loading' } | { status: 'ok'; ar: ArState } | { status: 'missing' } | { status: 'gone'; reason: 'expired' | 'revoked' | 'kept' } | { status: 'failed'; message: string };

const MB = 1024 * 1024;

async function fetchAr(token: string): Promise<Phase> {
  try {
    return { status: 'ok', ar: await api.get<ArState>(`/api/share/${encodeURIComponent(token)}/ar`) };
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404) return { status: 'missing' };
      if (error.status === 410) {
        const reason = (error.body as { reason?: string } | undefined)?.reason;
        return { status: 'gone', reason: reason === 'expired' ? 'expired' : reason === undefined ? 'kept' : 'revoked' };
      }
      return { status: 'failed', message: error.message };
    }
    return { status: 'failed', message: 'The server did not answer.' };
  }
}

export default function ArPage({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    let timer = 0;
    const look = () => {
      void fetchAr(token).then((p) => {
        if (!live) return;
        setPhase(p);
        // Being made: ask again until it is.
        if (p.status === 'ok' && (p.ar.status === 'queued' || p.ar.status === 'making')) timer = window.setTimeout(look, 2000);
      });
    };
    look();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [token]);

  if (phase.status === 'loading') return <Spinner label="Opening the AR model" />;
  if (phase.status === 'missing') return <Notice heading="This link does not open an AR model">It may have been mistyped, or the model it named is not shared any more.</Notice>;
  if (phase.status === 'gone') return <Notice heading={phase.reason === 'expired' ? 'This link has expired' : phase.reason === 'revoked' ? 'This link was revoked' : 'This AR model is no longer kept'}>Ask whoever shared it for a new link.</Notice>;
  if (phase.status === 'failed') return <Notice heading="The AR model did not open">{phase.message}</Notice>;
  const ar = phase.ar;
  if (ar.status === 'failed') return <Notice heading="This AR model was not made">Ask whoever shared it to make it again.</Notice>;
  const scaleWords = ar.scale === 'true' ? 'True scale · stand on the lot and walk round it' : 'Table scale · 1:50 · pinch to turn';
  return (
    <main className="fs-ar-page">
      <section className="fs-ar-page__card" aria-labelledby="fs-ar-page-title">
        <h1 className="fs-ar-page__title" id="fs-ar-page-title">
          {ar.project}
        </h1>
        <p className="fs-ar-page__sub">{scaleWords}</p>
        {ar.status !== 'done' ? (
          <div role="status" aria-live="polite">
            <Spinner label={ar.status === 'queued' ? 'Waiting for the worker' : 'The model is being made'} />
          </div>
        ) : quickLook() ? (
          <>
            {/* AR Quick Look takes a link whose one child is an image. */}
            <a className="fs-ar-page__open" rel="ar" href={`${ar.file}${arFragment(ar.scale)}`}>
              <img src="/icon-192.png" alt={`View ${ar.project} in AR`} width={96} height={96} />
            </a>
            <p className="fs-ar-page__note">Tap to place it with AR Quick Look{ar.scale === 'true' ? ', on the ground where the house will stand' : ' on a table'}.</p>
          </>
        ) : (
          <>
            <a className="fs-ar__download" href={ar.file} download={ar.name}>
              <Download aria-hidden="true" />
              {`Download ${ar.name}${ar.bytes === null ? '' : ` · ${(ar.bytes / MB).toFixed(1)} MB`}`}
            </a>
            <p className="fs-ar-page__note">Open this link on an iPhone or iPad to see the house in AR Quick Look.</p>
          </>
        )}
      </section>
    </main>
  );
}

function Notice({ heading, children }: { heading: string; children: string }) {
  return (
    <main className="fs-ar-page">
      <EmptyState kind="error" heading={heading}>
        {children}
      </EmptyState>
    </main>
  );
}
