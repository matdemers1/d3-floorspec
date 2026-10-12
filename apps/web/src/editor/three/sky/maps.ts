import { useEffect, useState } from 'react';
import { skyMapOf, type SkyMap, type SkyMapId, type SkyMaps } from '@floorspec/mesh/sky';
import clearUrl from '@floorspec/mesh/sky/clear.hdr?url';
import overcastUrl from '@floorspec/mesh/sky/overcast.hdr?url';
import duskUrl from '@floorspec/mesh/sky/dusk.hdr?url';
import nightUrl from '@floorspec/mesh/sky/night.hdr?url';

/**
 * The sky maps in the editor (FLR-T-13.4): the CC0 HDRIs @floorspec/mesh keeps, fetched the first
 * time a sky needs one — never in the editor's bundle — decoded once, and shared by the 3D view and
 * the GPU still.
 */

const URLS: Readonly<Record<SkyMapId, string>> = { clear: clearUrl, overcast: overcastUrl, dusk: duskUrl, night: nightUrl };
const loading = new Map<SkyMapId, Promise<SkyMap>>();
const loaded = new Map<SkyMapId, SkyMap>();

export function loadSkyMap(id: SkyMapId): Promise<SkyMap> {
  let p = loading.get(id);
  if (p === undefined) {
    p = fetch(URLS[id])
      .then(async (r) => {
        if (!r.ok) throw new Error(`the ${id} sky could not be fetched (${String(r.status)})`);
        const map = skyMapOf(id, new Uint8Array(await r.arrayBuffer()));
        loaded.set(id, map);
        return map;
      })
      .catch((error: unknown) => {
        loading.delete(id);
        throw error;
      });
    loading.set(id, p);
  }
  return p;
}

/** The maps asked for, once every one has loaded (null until then, or if one fails). */
export function useSkyMaps(ids: readonly SkyMapId[]): SkyMaps | null {
  const key = [...ids].sort().join(',');
  const ready = (): SkyMaps | null => {
    const out: SkyMaps = {};
    for (const id of ids) {
      const m = loaded.get(id);
      if (m === undefined) return null;
      out[id] = m;
    }
    return out;
  };
  const [maps, setMaps] = useState<SkyMaps | null>(ready);
  useEffect(() => {
    let live = true;
    const now = ready();
    if (now !== null) {
      setMaps(now);
      return;
    }
    Promise.all(ids.map((id) => loadSkyMap(id)))
      .then(() => { if (live) setMaps(ready()); })
      .catch(() => { if (live) setMaps(null); });
    return () => { live = false; };
  }, [key]);
  return maps;
}

/** Every map a set of skies needs, loaded (for the GPU still, which waits for them). */
export async function skyMaps(ids: readonly SkyMapId[]): Promise<SkyMaps> {
  const out: SkyMaps = {};
  for (const m of await Promise.all(ids.map((id) => loadSkyMap(id)))) out[m.id] = m;
  return out;
}
