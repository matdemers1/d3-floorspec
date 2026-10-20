import { Leaf } from 'lucide-react';
import { foliageOf, landscapeCollection } from '@floorspec/mesh';
import { SEASON_LABELS, type Look, type LookSeason } from '@floorspec/mesh/sky';
import type { EditorStore } from '../../store';
import type { EditorModel } from '../../model';
import { Section } from '../../fields';
import { useLook, useSunState } from './study';

/**
 * The inspector beside the Sky and sun panel (FLR-T-15.4, the board's "15.4 · Seasons and weather"):
 * "Plants through the year" — what the season does to the model's plants, each by its FS_landscape
 * foliage, and to the lawn — and what the look is: the sky, the shadows, the ground, the snow; and
 * the same look asked for over MCP. A look, never the model's: nothing here is written.
 */

/** "4 trees", "1 tree, 10 shrubs": the plants of a group by form. */
function counted(forms: readonly string[]): string {
  const by = new Map<string, number>();
  for (const f of forms) by.set(f, (by.get(f) ?? 0) + 1);
  const words: Record<string, [string, string]> = { tree: ['tree', 'trees'], shrub: ['shrub', 'shrubs'], grass: ['grass', 'grasses'], groundcover: ['groundcover', 'groundcovers'] };
  return [...by]
    .sort(([a], [b]) => Object.keys(words).indexOf(a) - Object.keys(words).indexOf(b))
    .map(([f, n]) => `${String(n)} ${(words[f] ?? [f, `${f}s`])[n === 1 ? 0 : 1]}`)
    .join(', ');
}

const DECIDUOUS: Readonly<Record<LookSeason, string>> = { spring: 'fresh leaves, blossom', summer: 'full leaf', autumn: 'autumn colour', winter: 'bare' };
const LAWN: Readonly<Record<LookSeason, string>> = { spring: 'greener', summer: 'mown green', autumn: 'yellowing, leaf litter', winter: 'dormant' };

/** The look in rows: the sky, the shadows, the ground and paving, snow on the roofs. */
function lookRows(look: Look, studio: boolean): [string, string][] {
  if (studio) return [['Backdrop', 'studio · even light']];
  const w = look.weather;
  return [
    ['Sky', w === 'clear' ? 'clear · the sun' : w === 'overcast' ? 'overcast · diffuse' : w === 'rain' ? 'overcast · rain' : 'overcast · snow'],
    ['Shadows', w === 'clear' ? 'cast by the sun' : 'contact only'],
    ['Ground and paving', w === 'rain' ? 'wet · glossy' : w === 'snow' ? 'under snow · walks cleared' : 'dry'],
    ['Snow on roofs', w === 'snow' ? 'yes' : 'no'],
  ];
}

/** Terms and what the look makes of them, one to a line. */
function List({ rows }: { rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="fs-seasons__list">
      {rows.map(([term, value]) => (
        <div key={term} className="fs-seasons__item">
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SeasonsPanel({ store, model }: { store: EditorStore; model: EditorModel }) {
  const look = useLook(store, model);
  const followDate = useSunState(store, (s) => s.followDate);
  const studio = useSunState(store, (s) => s.sky === 'studio');
  const plants = Object.values(landscapeCollection(model.document, 'plants'));
  const groups = (['deciduous', 'evergreen', 'unstated'] as const).map((f) => ({ foliage: f, forms: plants.filter((p) => foliageOf(p) === f).map((p) => (typeof p['form'] === 'string' ? p['form'] : 'plant')) }));
  const lawns = Object.keys(landscapeCollection(model.document, 'lawns')).length;
  const season = look.season;
  const mcp = `floorspec_render { view: "3d",\n  season: "${season}", weather: "${look.weather}" }`;
  return (
    <div className="fs-inspector__body fs-seasons">
      <header className="fs-seasons__head">
        <Leaf aria-hidden="true" />
        <div>
          <h2 className="fs-seasons__title">Plants through the year</h2>
          <p className="fs-seasons__sub">{`${SEASON_LABELS[season]} · ${followDate ? 'follows the date' : "from each plant's foliage"}`}</p>
        </div>
      </header>
      <Section title="Foliage (FS_landscape)">
        {plants.length === 0 ? <p className="fs-note">No FS_landscape plants: the lawn and the sky follow the season.</p> : null}
        <List
          rows={[
            ...groups.filter((g) => g.forms.length > 0).map((g): [string, string] => [`${g.foliage === 'unstated' ? 'Not stated' : g.foliage === 'deciduous' ? 'Deciduous' : 'Evergreen'} · ${counted(g.forms)}`, g.foliage === 'deciduous' ? DECIDUOUS[season] : g.foliage === 'evergreen' ? 'unchanged' : 'stay green']),
            [lawns === 0 ? 'The ground' : `Lawn${lawns === 1 ? '' : 's'}`, look.weather === 'snow' ? 'under snow' : LAWN[season]],
          ]}
        />
      </Section>
      <Section title="This look">
        <List rows={lookRows(look, studio)} />
      </Section>
      <Section title="Over MCP">
        <pre className="fs-seasons__mcp">{mcp}</pre>
      </Section>
      <p className="fs-note">Season is a look, not a change to the model: no op is written and nothing in quantities moves.</p>
    </div>
  );
}
