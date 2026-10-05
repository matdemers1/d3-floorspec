# 6. Measures of openings

Each measure here takes an opening as its target. An opening's effective `width`, `height` and
`sill` are Core's (Core §7.2), and its derived placement too (Core §7.4).

## 6.1 Kind

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingKind` | — | term | `"door"` when its `fill` is a `doorType`, `"window"` when it is a `windowType`, and `"empty"` for an opening with no `fill` |
| `openingOperation` | — | term | the `operation` of the door or window type that fills it (Core §8.4) — `"swing"`, `"casement"`, `"fixed"` and so on; no value for an empty opening, or when its type declares none |

An evaluator MUST compute `openingKind` as this section defines it. {#FS-RULES-6.1.1 MUST}

## 6.2 Size

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingWidth` | — | length | its effective `width` |
| `openingHeight` | — | length | its effective `height` |
| `openingArea` | — | area | `width × height`, exactly |

These are the **opening as drawn**: the hole in the wall that Core describes. The net clear opening
a code usually asks about — what remains when a window is open as far as it goes, or a door stands
open at 90° — is smaller, and is measured by 6.5 from what the door or window declares. A rule that
compares an opening's size as drawn with a net clear requirement measures something larger than the
code does, and says so in its paraphrase; its severity is usually `"check"` (3.11).

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-6.2.1 MUST}

## 6.3 Heights above the floor

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingSillHeight` | — | length | its sill elevation (Core §7.4) above the floor of its level (4.1) |
| `openingHeadHeight` | — | length | its head elevation above the floor of its level |

The floor is the level's elevation: a wall whose base is offset from its level, or set on another
level, raises its openings with it, and these measures see that.

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-6.3.1 MUST}

## 6.4 Outside

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingToOutside` | — | boolean | whether its wall has a half-edge on the boundary of its level's unbounded face (Core §6.1): whether the wall faces the outside |

An escape opening is an opening to the outside; a window between a bedroom and a sunroom is not
one, and neither is a door into a hall. A room's openings to the outside are its candidates
`"openings"` with `"to": "outside"` (3.5).

An evaluator MUST compute `openingToOutside` as this section defines it. {#FS-RULES-6.4.1 MUST}

## 6.5 Net clear opening

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingNetClearWidth` | — | length | the `width` of its clear opening (Core §7.4); no value when it has none |
| `openingNetClearHeight` | — | length | the `height` of its clear opening; no value when it has none |
| `openingNetClearArea` | — | area | the `area` of its clear opening, when one is declared; no value otherwise |
| `doorClearWidth` | — | length | for a door — an opening whose `openingKind` is `"door"` — the `width` of its clear opening; no value for a door with no clear opening, a window or an empty opening |

An opening's **clear opening** is what Core derives for it: its effective `clearOpening` (Core
§7.2), exactly as its door or window type declares it or the opening overrides it. Core never
computes a clear opening from a formula — it depends on the product: its frame, its sash or leaf,
its stops and how far it opens — so these measures read only what is declared. A Core 0.1 or 0.2
document declares none, and neither does a Core 0.3 document whose types and openings leave it
out.

The area is the declared one, never the clear width times the clear height: a window whose clear
opening declares no `area` has no value for `openingNetClearArea`, as one without a clear opening
has none for any of these measures. A measure with no value equals nothing (3.8), so a requirement
on it is not met: a rule that needs a clear opening finds the opening that does not state one,
and its finding shows the value as `not stated` (9.6) — which is what a reviewer needs to know. A
rule that wants only the openings that state one selects them with `openingNetClearWidth` `>=` 1,
which no opening without one passes, or says in its paraphrase that undeclared openings are
reported.

`doorClearWidth` is `openingNetClearWidth` for a door. For a door of more than one leaf — a pair
(`"doubleSwing"`), a bypass slider, a bifold — it is the clear width of the whole opening, every
leaf open, as declared: Core 0.3 declares no clear width for one leaf, so a requirement on a single
leaf of a pair is not yet measured. The door's operation does not change the measure; a rule
that cares — a requirement only for swinging doors, or only for windows that open — tests
`openingOperation` (6.1) in `where`.

An evaluator MUST compute the measures of this section as this section defines them, giving no value where it says so and never computing a clear width, height or area from the opening's own size. {#FS-RULES-6.5.1 MUST}
