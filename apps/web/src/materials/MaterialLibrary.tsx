import { useState } from 'react';
import { Button } from '@d3cloud/ui';
import { Check } from 'lucide-react';
import { embedLibraryMaterial, LIBRARY_CATEGORIES, LIBRARY_FILES, LIBRARY_MATERIALS, MATERIAL_LIBRARY, type LibraryCategory, type LibraryItemData } from '@floorspec/mesh/materials';
import type { EditorStore } from '../editor/store';
import type { Batch } from '../editor/ops';
import { messageOf } from '../lib/api';
import { libraryFileBlob } from './library';
import { uploadTexture } from './api';
import './materials.css';

/**
 * The material library in the Materials modal (FLR-T-13.6; the board's frame 13c): CC0 materials at
 * their real size, by category, each a card with a swatch of 2 ft of it, what it is and how big a
 * tile is. "Add" copies its maps into the project's asset store (FLR-T-8.2) — so the model's package
 * is complete on its own — and embeds it: assets and a material whose `source` names the library
 * and the item (Core 8.1), in one batch of Floorspec ops. A colour-agnostic item — a paint, a
 * plaster, siding, a standing seam — is drawn in its colour: its maps are only its relief.
 */

const PREVIEWS = import.meta.glob<string>('../../../../packages/mesh/materials/previews/*.jpg', { query: '?url&no-inline', import: 'default', eager: true });
const previewOf = (id: string): string | undefined => Object.entries(PREVIEWS).find(([k]) => k.endsWith(`/${id}.jpg`))?.[1];

/** A tile's size in words: metric, as the library measures it. */
function tileText(item: LibraryItemData): string | null {
  const t = item.texture;
  if (t === undefined) return null;
  const mm = (v: number) => v / 1280;
  const fmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 2).replace(/\.?0+$/, '')} m` : `${String(Math.round(v))} mm`);
  const [w, h] = [mm(t.size[0]), mm(t.size[1])];
  return Math.abs(w - h) < 0.5 ? `${fmt(w)} repeat` : `${fmt(w)} × ${fmt(h)} repeat`;
}

/** What the card says under the name: the repeat, whether the colour is the person's, and where it goes. */
export function cardMeta(item: LibraryItemData): string {
  const agnostic = item.texture?.maps.albedo === undefined;
  return [agnostic ? 'your colour' : null, tileText(item), item.uses.join(', ')].filter((x) => x !== null).join(' · ');
}

/** The swatch's style: its preview — 2 ft of it at its real size — multiplied by its colour where it has no colour map. */
export function librarySwatch(item: LibraryItemData, color?: string): React.CSSProperties {
  const url = previewOf(item.id);
  const agnostic = item.texture?.maps.albedo === undefined;
  return {
    backgroundColor: agnostic ? (color ?? item.color) : item.color,
    ...(url === undefined ? {} : { backgroundImage: `url("${url}")`, backgroundSize: 'cover', ...(agnostic ? { backgroundBlendMode: 'multiply' } : {}) }),
  };
}

/** Copy an item's map files into the project's store, then embed it. False when the batch did not apply. */
export async function addLibraryMaterial(store: EditorStore, item: LibraryItemData): Promise<{ ok: boolean; id?: string }> {
  const model = store.get().model;
  if (model === null) return { ok: false };
  const maps = item.texture?.maps;
  const files = [...new Set([maps?.albedo, maps?.normal, maps?.orm].filter((f): f is string => f !== undefined))];
  // The files first, so the model never names a map its project cannot serve. A store that will not take
  // them (an instance with no asset store) still gets the material: every view draws a library map from
  // the app's own copy, and the package export says what it left out.
  try {
    await Promise.all(
      files.map(async (file) => {
        const blob = await libraryFileBlob(file);
        const stored = await uploadTexture(store.projectId, Object.assign(blob, { name: file }));
        if (stored.sha256 !== LIBRARY_FILES[file]?.sha256) throw new Error(`${file} was stored as ${stored.sha256}, not as its library digest`);
      }),
    );
  } catch (e) {
    store.set({ notice: { tone: 'info', text: `${item.name}'s textures were not copied into the project (${messageOf(e)}); the views draw them from the library.` } });
  }
  const { id, ops } = embedLibraryMaterial(model.document, item.id);
  const ok = await store.apply(`Add ${item.name}`, ops as unknown as Batch);
  return ok ? { ok, id } : { ok };
}

export function MaterialLibrary({ store, held, onAdded }: { store: EditorStore; held: ReadonlySet<string>; onAdded?: (id: string) => void }) {
  const [category, setCategory] = useState<LibraryCategory>('wood');
  const [busy, setBusy] = useState<string | null>(null);
  const items = LIBRARY_MATERIALS.filter((i) => i.category === category);
  return (
    <section className="fs-matlib" aria-label="Material library">
      <h3 className="fs-overline">Material library · CC0 · {MATERIAL_LIBRARY.version}</h3>
      <div className="fs-matlib__chips" role="group" aria-label="Category">
        {LIBRARY_CATEGORIES.map((c) => (
          <Button key={c.id} size="sm" variant={c.id === category ? 'primary' : 'secondary'} aria-pressed={c.id === category} onClick={() => { setCategory(c.id); }}>
            {c.name}
          </Button>
        ))}
      </div>
      <p className="fs-matlib__hint">Each swatch shows 2 ft of the surface at its real size. A material added from here names the library and the item in its source.</p>
      <ul className="fs-matlib__grid" aria-label={`${LIBRARY_CATEGORIES.find((c) => c.id === category)?.name ?? ''} materials`}>
        {items.map((item) => {
          const inProject = held.has(item.id);
          return (
            <li key={item.id} className="fs-matlib-card" data-testid={`library-material-${item.id}`}>
              <span className="fs-matlib-card__swatch" style={librarySwatch(item)} aria-hidden="true" />
              <span className="fs-matlib-card__name">{item.name}</span>
              <span className="fs-matlib-card__meta">{cardMeta(item)}</span>
              <span className="fs-matlib-card__actions">
                <Button
                  size="sm"
                  variant="secondary"
                  icon={inProject ? <Check /> : undefined}
                  disabled={busy !== null}
                  aria-label={`${inProject ? 'Add another' : 'Add'} ${item.name}`}
                  onClick={() => {
                    setBusy(item.id);
                    void addLibraryMaterial(store, item).then((r) => {
                      setBusy(null);
                      if (r.ok && r.id !== undefined) onAdded?.(r.id);
                    });
                  }}
                >
                  {busy === item.id ? 'Adding…' : inProject ? 'Add again' : 'Add'}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <p className="fs-matlib__hint">Adding copies its maps into this project, so the model stays complete on its own. &ldquo;Your colour&rdquo;: the maps are only relief, and the material keeps the colour you give it. Turn a texture 90° in the inspector to run planks the other way.</p>
    </section>
  );
}
