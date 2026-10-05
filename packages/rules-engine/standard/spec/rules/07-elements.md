# 7. Measures of elements and clearance envelopes

The measures of 7.1 to 7.4 take an extension element as their target; those of 7.5 to 7.8 take a
clearance envelope. An element's fallback, placement and clearance envelopes are Core's (Core
§12.6, §13.4, §13.5); its frame is Core's (Core §13.1).

## 7.1 Members

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementMember` | `name`: a member name matching `^[a-z][A-Za-z0-9]*$` (required); `type`: `"integer"`, `"term"`, `"terms"` or `"boolean"` (required); `unit`: `"V"`, `"A"` or `"W"` (optional, with `"type": "integer"` only) | as `type` | the element's member `name`, read with its default (4.5), when it is of `type` — a JSON integer, a string, an array of strings, or a boolean; otherwise no value |

`elementMember` reads the element's extension (4.6) — the extension the rule names for its targets
(3.9): a receptacle's `amps`, an alarm's `detects`, a water heater's `energy`. An integer with a `unit` is displayed with it (9.6). A member the element
does not have, and its extension gives no default, has no value (4.2); so does one of another type
than `type`.

An evaluator MUST compute `elementMember` as this section defines it. {#FS-RULES-7.1.1 MUST}

## 7.2 The room an element is in

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementRoomFunction` | — | term | the `roomFunction` (5.1) of the room the element is in (4.4), or `"none"` when it is in no room |

An evaluator MUST compute `elementRoomFunction` as this section defines it. {#FS-RULES-7.2.1 MUST}

## 7.3 Heights above the floor

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementBottomAboveFloor` | — | length | the bottom of its fallback (Core §12.6) above the floor of its level (4.1) |
| `elementTopAboveFloor` | — | length | the top of its fallback above the floor of its level |

A panel's highest breaker, a water heater's burner, a receptacle's centre: a fallback box is the
element's extent, so a rule about a height reads the box an extension's writer gives the element.

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-7.3.1 MUST}

## 7.4 Protection

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementProtectedBy` | `protection`: `"gfci"` or `"afci"` (required) | boolean | whether the element has `protection` in its own `features` (FS_electrical §2.2), read with its default, or is a load (FS_electrical §3.2) of a circuit that has `protection` in its `protection` |

`elementProtectedBy` reads FS_electrical. Its result's `involved` lists the circuits that give the
protection.

An evaluator MUST compute `elementProtectedBy` as this section defines it. {#FS-RULES-7.4.1 MUST}

## 7.5 Envelopes as declared

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `envelopePurpose` | — | term | its `purpose`: `"workingSpace"`, `"fixtureClearance"`, `"swing"` or `"access"` |
| `envelopeDepth` | — | length | `max.x − min.x`: how far it reaches forward |
| `envelopeWidth` | — | length | `max.y − min.y` |
| `envelopeHeight` | — | length | `max.z − min.z` |
| `envelopeBottomAboveFloor` | — | length | its bottom (Core §13.2) above the floor of its owner's level |

These read the envelope as its owner declares it. Whether the space it names is actually clear is
7.6 to 7.8.

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-7.5.1 MUST}

## 7.6 Obstructions

An envelope `E`, of owner `X` on level `L`, is the box `[x0, x1] × [y0, y1] × [z0, z1]` in `X`'s
frame (Core §13.5). Its **plan rectangle** is the set of plan points whose local coordinates
`(p, q)` (Core §13.1) have `x0 ≤ p ≤ x1` and `y0 ≤ q ≤ y1` — exactly, not rounded — and its vertical
range is `[bottom, top]`, its derived bottom and top (Core §13.2).

Its **obstacles** are:

- every wall on `L`, except the wall that hosts `X` (an opening's wall, or a `wallFace` host's
  wall): the wall's outline (Core §5.7), from its base elevation to its top elevation (Core §5.9);
- every extension element other than `X` whose fallback's `level` is `L`: its fallback's footprint
  (Core §12.6), from its bottom to its top.

An obstacle **obstructs** `E` when the interior of its plan polygon and the interior of `E`'s plan
rectangle intersect, and its vertical range and `E`'s overlap by a positive length. An opening does
not open a wall here: a wall with a door in it obstructs the space in front of a panel as the wall
would without one.

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `envelopeObstructions` | — | count | the number of `E`'s obstacles that obstruct it; `involved` lists them |

A boiler set beside a panel, inside the panel's working space, obstructs it; so does the wall of a
closet too shallow for the space. A door's swing over the working space is not an obstruction but
an overlap of envelopes (7.8).

An evaluator MUST compute `envelopeObstructions` as this section defines it. {#FS-RULES-7.6.1 MUST}

## 7.7 Clear depth in front

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `clearDepthInFront` | `limit`: a length greater than zero (required) | length | how far forward from `E`'s near face the space stays clear, within `E`'s width and height, up to `limit` |

The **strip** in front of `E` is the set of plan points whose local coordinates have `p > x0` and
`y0 < q < y1`. For each obstacle of `E` (7.6) whose vertical range overlaps `E`'s by a positive
length, and whose plan polygon's interior meets the strip, its **distance** is the greatest lower
bound of `p − x0` over the points of its interior in the strip. The clear depth `D` is the least of
these distances, or unbounded when there is none; the measure is `min(limit, round(D))`. Its
`involved` lists the obstacles whose distance is exactly `D`, when `round(D)` is less than `limit`,
and is empty otherwise.

`clearDepthInFront` measures past the envelope's own depth, up to `limit`: a rule that asks for
three feet of clear space in front of a panel reads `clearDepthInFront` with a limit of three feet,
whatever depth the panel's writer declared. The search runs within the envelope's width and height,
so a wall above the envelope's top, or beside it, does not shorten it.

An evaluator MUST compute `clearDepthInFront` as this section defines it. {#FS-RULES-7.7.1 MUST}

## 7.8 Overlapping envelopes

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `envelopeOverlaps` | `purpose`: a purpose (optional) | count | the number of envelopes of other owners that overlap `E` (Core §13.6) — of that purpose, when given; `involved` lists their owners |

This is Core's overlap measure, read as Core derives it: a door's `swing` over a panel's
`workingSpace` is one overlap of each.

An evaluator MUST compute `envelopeOverlaps` as this section defines it. {#FS-RULES-7.8.1 MUST}
