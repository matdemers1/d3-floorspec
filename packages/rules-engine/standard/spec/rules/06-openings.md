# 6. Measures of openings

Each measure here takes an opening as its target. An opening's effective `width`, `height` and
`sill` are Core's (Core §7.2), and its derived placement too (Core §7.4).

## 6.1 Kind

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingKind` | — | term | `"door"` when its `fill` is a `doorType`, `"window"` when it is a `windowType`, and `"empty"` for an opening with no `fill` |

An evaluator MUST compute `openingKind` as this section defines it. {#FS-RULES-6.1.1 MUST}

## 6.2 Size

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `openingWidth` | — | length | its effective `width` |
| `openingHeight` | — | length | its effective `height` |
| `openingArea` | — | area | `width × height`, exactly |

These are the **opening as drawn**: the hole in the wall that Core describes. Core 0.2 describes no
sash, frame, leaf or stop, so the net clear opening a code usually asks about — what remains when a
window is open as far as it goes, or a door stands open at 90° — is not measured: those measures are
deferred (4.8). A rule that compares an opening's size with a net clear requirement measures
something larger than the code does, and says so in its paraphrase; its severity is usually
`"check"` (3.11).

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
