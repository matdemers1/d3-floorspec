# 8. Wall lines, receptacles, circuits and levels

## 8.1 The wall line of a room

Electrical codes measure receptacle spacing along the walls of a room, around corners, and stop at
doorways. The **wall line** of a room is that path: the inside faces of the edges around it,
walked once around its room polygon's outer ring, with its **breaks** marked. It is built from the
walk of the outer cycle of the room's face (Core §6.1), exactly as Core §6.2 builds the outer ring
— before vertices that repeat are removed:

- Where the walk passes through a junction `J`, arriving along `e_m` and leaving along `e_(m−1)`,
  the ring takes the corner sequence of wedge `m − 1` in reverse: one point, or two, each rounded
  (Core §2.2). When it takes two, the segment between them is a **return** at `J`: the end of a wall
  that stops free in the room, or the step between two collinear edges of different thickness.
- Between the last point the ring takes at one junction and the first point it takes at the next
  lies the **run** of the half-edge between them: along the face, on the room's side, of that
  half-edge's edge.

In walk order — each half-edge's run, then the return at the junction it arrives at, if there is
one — runs and returns make one closed path. Its lengths are integers, each rounded once:

- The **position** on an edge `e` of a plan point `P` is `round((P − S) · d / |d|)`, where `S` is
  `e`'s start junction's position and `d` its direction (Core §5.2): the distance along `e`'s
  location line, from its start, of `P`'s projection onto it.
- A run of a half-edge of `e` goes from the position `s₁` of its first point to the position `s₂` of
  its last. Its **length** is `s₂ − s₁` when the half-edge runs from `e`'s start to its end, and
  `s₁ − s₂` when it runs from end to start — or 0, when that is negative. A point of `e` at position
  `s` between them is at distance `|s − s₁|` along the run.
- A return's length is `round(|q − p|)`, for its two points `p` and `q`.

A run's **breaks** are the whole run when `e` is a separator; and, when `e` is a wall, for each
opening on `e` whose `fill` is absent or a `doorType` — a doorway (Core §11.4) — the part of the
run at positions from the opening's `offset` to `offset + width`, when that part has a positive
length. A **stretch** is a maximal part of the wall line, of positive length, that has no point of
a break inside it. A wall line with no break is one **closed** stretch: it has no ends.

The **receptacles on the wall line** are the extension elements of the collection `receptacles` of
`FS_electrical` with a `wallFace` host on a wall `e` of a run, on the room's side of `e` — `"left"`
when the half-edge runs from `e`'s start to its end, `"right"` when it runs from end to start —
whose `offset` lies from `s₁` to `s₂` (inclusive); each is at the distance of its `offset` along the
run.

An evaluator MUST build the wall line of a room, its stretches and the receptacles on it, exactly as this section defines them. {#FS-RULES-8.1.1 MUST}

## 8.2 Receptacle reach

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `receptacleReach` | `match`: a match (optional); `maxHeight`: a length (optional) | length | the greatest distance, along the room's wall line and within one stretch, from a point of it to the nearest counted receptacle — a stretch with none counting its whole length — rounded once |
| `wallRunBetweenReceptacles` | the same | length | the longest part of a stretch with no counted receptacle inside it: between two receptacles, between an end of the stretch and a receptacle, or a whole stretch with none |

The **counted** receptacles are the receptacles on the wall line (8.1) that match `match`, when it
is given, and whose placement (Core §13.4) is at most `maxHeight` above the floor of the room's
level, when it is given. For a stretch of length `ℓ` with counted receptacles at distances
`r₁ ≤ … ≤ rₖ` from its start:

| | `receptacleReach` of the stretch | `wallRunBetweenReceptacles` of the stretch |
|---|---|---|
| `k = 0` | `ℓ` | `ℓ` |
| `k > 0`, with ends | the greatest of `r₁`, `ℓ − rₖ` and every `(rᵢ₊₁ − rᵢ) / 2` | the greatest of `r₁`, `ℓ − rₖ` and every `rᵢ₊₁ − rᵢ` |
| `k > 0`, closed | the greatest `(rᵢ₊₁ − rᵢ) / 2`, counting `r₁ + ℓ − rₖ` as a gap | the greatest `rᵢ₊₁ − rᵢ`, counting `r₁ + ℓ − rₖ` as a gap |

Each measure is the greatest of its values over the room's stretches, rounded once (a half-gap can
be a half), or 0 when the room has no stretch. Its `involved` lists the counted receptacles.

A rule that no point along a room's wall line is more than six feet from a receptacle reads
`receptacleReach` with a threshold of six feet; one about the space between receptacles reads
`wallRunBetweenReceptacles`. With a match, both read FS_electrical; without one, they read only core
members, and count every receptacle of FS_electrical on the wall line.

An evaluator MUST compute `receptacleReach` and `wallRunBetweenReceptacles` as this section defines them. {#FS-RULES-8.2.1 MUST}

## 8.3 Circuits

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `circuitCount` | `collection`: a collection name (optional, default `"receptacles"`); `match`: a match (optional); `circuit`: a match (optional) | count | the number of FS_electrical circuits (FS_electrical §3.1) that match `circuit`, when given, and have among their `loads` an element of FS_electrical's `collection` that is in the room (4.4) and matches `match`, when given; `involved` lists them |

`circuitCount` reads FS_electrical. A kitchen's small-appliance circuits are its receptacle circuits
of 20 A: `circuitCount` with `"circuit": { "breaker": 20 }`.

An evaluator MUST compute `circuitCount` as this section defines it. {#FS-RULES-8.3.1 MUST}

## 8.4 Levels

| Measure | Arguments | Type | Value |
|---|---|---|---|
| `elementCount` | `extension` (required), `collection` (optional), `match` (optional), as 5.6 | count | the number of extension elements of that extension — and collection — whose fallback's `level` is the level, and that match `match`, when given |
| `roomCount` | `function`: a room function (optional) | count | the number of rooms on the level — of that `roomFunction`, when given |

A rule that every level has a smoke alarm reads `elementCount` of each level.

An evaluator MUST compute the measures of this section as this section defines them. {#FS-RULES-8.4.1 MUST}
