# 5. Measures of rooms

Each measure here takes a room as its target. A room's **face** and **room polygon** are Core's
(Core §6.1, §6.2); every measure is of a valid document, so every room has both.

## 5.1 Function

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `roomFunction` | — | term | the room's `function` as the document gives it, with its default `"unspecified"` (Core §6.5): a term of Core §4.1, or an extension term as written (Core §4.2) |

An evaluator MUST compute `roomFunction` as this section defines it. {#FS-RULES-5.1.1 MUST}

## 5.2 Net area

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `roomNetArea` | — | area | the room's net area (Core §6.4): its room polygon's outer ring's area minus its holes', from the rounded vertices — exactly, a multiple of one half |

Gross areas, and areas by a published measurement standard, are not in this draft.

An evaluator MUST compute `roomNetArea` as this section defines it. {#FS-RULES-5.2.1 MUST}

## 5.3 Least width

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `roomLeastWidth` | — | length | the least width of the room polygon's outer ring, rounded once |

The **width** of a ring in a direction is the distance between the two parallel lines, at right
angles to that direction, that the ring lies between and touches; its **least width** is the least
of these over every direction. It is attained in a direction at right angles to an edge of the
convex hull of the ring's vertices, so it is the least, over the edges `(a, b)` of that hull, of the
greatest distance from the line through `a` and `b` of a vertex of the ring:
`|(b − a) × (v − a)| / |b − a|`. Each of those is an integer divided by the square root of an
integer; the least is found exactly, and rounded once.

The least width of a rectangular room is its shorter side, inside the finished walls. Holes are not
considered: a column in a room does not narrow it. A room that is not convex — an L — has the least
width of its convex hull, which can be more than the width of one of its legs; the dimension at
every point is `roomNarrowestDimension`, deferred (4.8). A hall's width is the `roomLeastWidth` of
a room whose function is `circulation`.

An evaluator MUST compute `roomLeastWidth` as this section defines it. {#FS-RULES-5.3.1 MUST}

## 5.4 Circulation

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `roomIsEntry` | — | boolean | whether the room is an entry of its building (Core §14.2) |
| `roomIsReachable` | — | boolean | whether it is reachable (Core §14.3) |
| `roomThroughSleeping` | — | boolean | for a sleeping room, whether it is reachable only through another sleeping room (Core §14.3); `false` for every other room |

These are Core's derived circulation values, read as they are. A rule that a sleeping room must
not be reached only through another, or that every room needs a way in, reads them with its own
citation (Core §14.4).

An evaluator MUST compute the measures of this section as Core derives the values they read. {#FS-RULES-5.4.1 MUST}

## 5.5 Neighbours

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `roomAdjacentTo` | `function`: a room function (required) | boolean | whether the room is adjacent (Core §11.4) to some other room whose `roomFunction` is `function` |
| `roomConnectedTo` | `function`: a room function (required) | boolean | whether the room is connected (Core §11.4) — through a separator, a door or an empty opening — to some other room whose `roomFunction` is `function` |

A rule that a garage must not open into a sleeping room reads `roomConnectedTo` with
`"function": "sleeping"` on rooms of function `garage`.

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-5.5.1 MUST}

## 5.6 Elements in a room

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementCount` | `extension`: an extension name (required); `collection`: a collection name (optional); `match`: a match (4.5, optional) | count | the number of extension elements in the room (4.4) of that extension — and of that collection, when given — that match `match`, when given |

With a match, `elementCount` reads the extension (4.6). Without one it reads only core members, so
it counts the elements of an extension the evaluator does not implement too: the smoke alarms in
a bedroom need FS_electrical (`"match": { "detects": "smoke" }`); every alarm in it does not.
`elementCount` of a level is in 8.4.

An evaluator MUST compute `elementCount` of a room as this section defines it. {#FS-RULES-5.6.1 MUST}
