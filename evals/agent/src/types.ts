/**
 * The shapes of the eval: a task, its seed, and the assertions that score it.
 *
 * An assertion is checked against the **resulting model** — the pending changeset the agent's edits
 * landed in, or main when it made none — never against the transcript. The two exceptions read the
 * agent's final reply, and only for tasks whose correct outcome is a reply: `answer` (a read-only
 * question) and `asked` (an ambiguous request, where asking is right).
 *
 * Lengths in assertions are strings in the Floorspec Ops length grammar (`2'`, `36"`, `1/16"`) or
 * integers of base units. A coordinate interval is `[lo, hi]`, inclusive.
 */

export type Length = string | number;
export type Interval = readonly [Length, Length];

/** A room: its ID in the seed, or a match on its name (a case-insensitive regular expression). */
export type RoomRef = string | { readonly name: string; readonly level?: string };

/** Which wall(s) an assertion is about, read from the resulting model's faces. */
export type WallSel =
  | { readonly between: readonly [RoomRef, RoomRef] }
  /** The walls on one side of a room (Ops §3.4), or all its walls; `exterior` keeps only exterior ones. */
  | { readonly of: RoomRef; readonly side?: 'north' | 'east' | 'south' | 'west'; readonly exterior?: boolean }
  | { readonly walls: readonly string[] };

export type OpeningKind = 'door' | 'window' | 'opening' | 'door-or-opening';

export type Direction = 'north' | 'east' | 'south' | 'west';

export type Assertion =
  /** The resulting model is a valid Floorspec Core document. */
  | { readonly kind: 'valid' }
  /** The resulting model is exactly the seed (a read-only task, or a request the agent should ask about). */
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'changed' }
  /**
   * A room's bounding box moved by exactly these deltas (each side not named stays put). The room is
   * named by its seed ID; it must still exist.
   */
  | {
      readonly kind: 'roomEdges';
      readonly room: string;
      readonly delta: Partial<Record<'minX' | 'maxX' | 'minY' | 'maxY', Length>>;
      readonly tol?: Length;
      /** Tolerance for the sides that stay put (default `tol`): a jog wall's face may sit a little off the partition it replaces. */
      readonly keepTol?: Length;
    }
  /** These rooms keep their outline (bounding box) and net area. */
  | { readonly kind: 'roomsUnchanged'; readonly rooms: readonly string[]; readonly tol?: Length }
  | { readonly kind: 'roomCount'; readonly level?: string; readonly delta?: number; readonly equals?: number }
  /** At least one room matches every given condition. */
  | {
      readonly kind: 'roomExists';
      readonly name?: string;
      readonly function?: string;
      readonly level?: string;
      /** Only rooms whose ID is not in the seed. */
      readonly new?: boolean;
      readonly bbox?: Partial<Record<'minX' | 'maxX' | 'minY' | 'maxY', Interval>>;
      readonly size?: Partial<Record<'eastWest' | 'northSouth', Interval>>;
      readonly areaSqft?: readonly [number, number];
    }
  /**
   * New openings (IDs not in the seed) of this kind in the selected wall(s): exactly `count` (default
   * 1), each with the given width and, when `centred`, centred within `tol` — on the wall's location
   * line, or on either of its finished faces, so every reasonable reading of "centred" passes.
   */
  | {
      readonly kind: 'openingAdded';
      readonly on: WallSel;
      readonly type: OpeningKind;
      readonly width?: Length;
      /** Accept any width in this range instead of one width. */
      readonly widthRange?: Interval;
      readonly centred?: boolean;
      readonly count?: number;
      readonly tol?: Length;
    }
  /**
   * A seed opening moved by exactly this vector, keeping its width. A replacement (removed and added
   * again with the same fill and width) at the moved position passes too.
   */
  | { readonly kind: 'openingMoved'; readonly opening: string; readonly by: Partial<Record<Direction, Length>>; readonly tol?: Length }
  /**
   * Exactly one opening of this kind is centred where the seed opening `near` was centred (within
   * `tol`), with this width; whether it kept its ID or was replaced does not matter, and nothing else
   * overlaps it on that wall line.
   */
  | {
      readonly kind: 'openingAt';
      readonly near: string;
      readonly type: OpeningKind;
      readonly width?: Length;
      readonly widthAtLeast?: Length;
      readonly widthAbove?: Length;
      readonly tol?: Length;
    }
  /** The seed opening is gone, and nothing of its kind replaced it at its position. */
  | { readonly kind: 'openingRemoved'; readonly opening: string; readonly tol?: Length }
  /** Every seed opening, except these, is still there with its ID, width and position. */
  | { readonly kind: 'openingsUnchanged'; readonly except?: readonly string[]; readonly only?: readonly string[]; readonly tol?: Length }
  | { readonly kind: 'levelCount'; readonly delta?: number; readonly equals?: number }
  /** A level matching every condition exists (with `new`, one whose ID is not in the seed). */
  | { readonly kind: 'levelExists'; readonly new?: boolean; readonly elevation?: Interval; readonly height?: Interval; readonly name?: string }
  /**
   * A new level's walls cover every exterior wall location line of `from`, collinear and end to end
   * within `tol` — "the same footprint walls".
   */
  | { readonly kind: 'footprintCopied'; readonly from: string; readonly tol?: Length }
  /**
   * New wall(s) — location lines not lying on any seed wall — run along one line on `level`: north–south
   * at an x in `at`, or east–west at a y in `at`, together covering `span` (the other coordinate).
   */
  | {
      readonly kind: 'wallLine';
      readonly level: string;
      readonly orientation: 'ns' | 'ew';
      readonly at: Interval;
      readonly span: Interval;
      readonly tol?: Length;
    }
  /** No diagnostic with this code in the resulting model. */
  | { readonly kind: 'diagnosticAbsent'; readonly code: string }
  /** The reply's last `ANSWER:` line says this. */
  | { readonly kind: 'answer'; readonly expect: AnswerExpectation }
  /** Nothing changed, and the reply asks the person a question. */
  | { readonly kind: 'asked' }
  /** At least one group passes in full: every acceptable outcome of an ambiguous request. */
  | { readonly kind: 'anyOf'; readonly label?: string; readonly groups: readonly (readonly Assertion[])[] };

export type AnswerExpectation =
  /** Exactly these seed rooms are named (by name or ID). */
  | { readonly rooms: readonly string[] }
  | { readonly number: number; readonly tol: number }
  | { readonly yesno: 'yes' | 'no' }
  /** Exactly the `expect` members of `universe` are mentioned. */
  | { readonly set: { readonly universe: readonly string[]; readonly expect: readonly string[] } };

/** How the harness asks for the final answer of a read-only task (appended to the prompt). */
export type AnswerFormat = 'rooms' | 'number' | 'yesno' | 'list';

/** A seed: a seed file's name in `seeds/`, a document, or batches applied in order to an empty document. */
export type Seed = string | { readonly document: object } | { readonly batches: readonly (readonly object[])[] };

/** A scripted correct way to do the task, used by the harness's self-check — never shown to Claude. */
export interface Reference {
  readonly label?: string;
  /** Batches an agent would send, in order. */
  readonly batches?: readonly (readonly object[])[];
  /** The reply an agent would give (read-only and ambiguous tasks). */
  readonly reply?: string;
}

export interface Task {
  readonly id: string;
  readonly title: string;
  /** What the eval measures with this task: resize, move-opening, add-opening, split, level, read, ambiguous, diagnostic … */
  readonly category: string;
  /** What the homeowner types. */
  readonly prompt: string;
  readonly seed: Seed;
  readonly assertions: readonly Assertion[];
  /** Read-only tasks: the harness asks for a final `ANSWER:` line in this format. */
  readonly answer?: { readonly format: AnswerFormat };
  /** Why the assertions are what they are — tolerances, accepted readings. */
  readonly notes?: string;
  /** At least one correct solution; the self-check proves each one passes and the seed alone fails. */
  readonly references: readonly Reference[];
}

export interface AssertionResult {
  readonly kind: string;
  readonly pass: boolean;
  readonly detail: string;
}

export interface Score {
  readonly pass: boolean;
  readonly results: readonly AssertionResult[];
}
