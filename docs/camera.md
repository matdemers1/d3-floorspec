# The camera

Saved views, the lens, two-point perspective, depth of field, exposure, the frame and the shot list
(FLR-T-13.10): how a house is photographed in every view — the editor's 3D view, the headless
render, the worker's path tracer and the editor's GPU still — and how a photograph is kept.

## Saved views live in the document

A saved view is what the owner means the house to be photographed as, and an agent renders it by
name, so it is design intent kept in the document: FS_views 0.1.0 (Draft, FLR-ADR-046), an official
extension that adds no kind of element and requires none.

```json
"FS_views": {
  "views": {
    "SV1": {
      "name": "Hero exterior",
      "eye": [-19200000, 8320000, 2048000],
      "target": [12800000, 10880000, 4096000],
      "focalLength": 24,
      "twoPoint": true,
      "aspect": "3:2",
      "exposure": -3,
      "sky": "clear",
      "at": "2026-06-21T20:05-04:00"
    }
  }
}
```

| Member | Default | What it is |
|---|---|---|
| `eye`, `target` | — | exact lengths `[x, y, z]`, z above project zero |
| `focalLength` | 35 | mm, on a frame whose long side is 36 mm |
| `twoPoint` | false | verticals kept vertical: the camera held level, the lens shifted |
| `aspect` | `3:2` | `3:2`, `16:9`, `4:5` or `1:1` |
| `aperture`, `focus` | all sharp | an f-stop (`f/1.4` … `f/22`) and the distance in focus (a length; default the target's) |
| `exposure` | 0 | compensation, tenths of a stop |
| `level`, `levels` | whole house | cut away above `level`; `levels: "only"` shows it alone |
| `sky`, `at` | clear, a reader's own time | the sky and the date and time that place the sun |
| `lights`, `scene` | off | `"on"` every light at full, or an FS_lighting scene |

The editor saves, updates, renames and deletes views with Ops on `$document`, declaring FS_views
where it is not yet; an agent writes one with `setProperty` of `$document`. `floorspec_describe` lists
them.

## One camera, made in one place

`@floorspec/mesh` `viewCamera(view)` is the only place a view becomes a camera:

- **The lens.** The picture's long side spans 36 mm, so `focalLength` gives the same field of view
  across the long side whatever the frame: 24 mm is 74° across, 50 mm 40°. The vertical field of view
  follows from the frame's shape.
- **Two-point perspective** is a shift lens: the camera looks level, along the line from the eye to
  the target brought down (or up) to the eye's height, and the picture's middle is moved up by
  `(rise / run) / tan(fovY / 2)` half-heights, so the target stays in the middle of the picture and
  every vertical line stays vertical. Looking more than 30° up or down, the shift takes the picture far
  off its subject, and FS-VIEW-LINT-001 says so; past a slope of 20 the shift is given up.
- **Depth of field** is a thin lens of the focal length at the f-number — an aperture `f / N`
  across, as a 35 mm camera's — focused on a plane across the line of sight at `focus` (or the
  target's distance). The CPU tracer starts each ray on the lens disc toward where its pinhole ray
  meets that plane; the GPU still uses three-gpu-pathtracer's physical camera with a 36 mm film gauge,
  which is the same lens. The rasterizer is a drawing and draws everything sharp, and so does the
  editor's live view; stills and shot lists show the depth of field.
- **Exposure compensation** multiplies whatever exposure a view is metered or set to (see
  [lighting.md](lighting.md)) by 2^(tenths / 10).

Each renderer takes that camera as it is: the worker's `savedCamera` (a `shift` and a `lens` on its
Camera, which the rasterizer projects with and the tracer traces), the GPU still's
`savedViewCamera` (a view offset for the shift), and the editor's controller (a view offset too).

## In the editor

The 3D view's Camera button (the board's "30 · Editor — 3D camera") opens the Camera panel:

- **Saved views:** going to one sets the orbit to its eye and target, its lens and frame, the levels
  shown, the sky and the clock, and its lights or scene. **Save view…** keeps the view now — the
  orbit, the lens, the levels shown, the Sky and sun panel's sky and clock (with the offset it is read
  in), and the lights: the chosen scene when it is one of the document's and unchanged, every light
  when the lights are on otherwise.
- **Lens:** a focal length from 12 to 200 mm on a log slider, with 16, 24, 35, 50 and 85 mm.
- **Two-point perspective, depth of field, exposure** as above.
- **Frame:** the aspect, and framing guides — the picture's shape fitted in the view with a margin,
  outside it dimmed, the rule of thirds and a centre mark inside. The view's field of view is set so
  the frame spans exactly the lens's: what is inside the frame is what the still shows.

The lens and frame are view state until a view is saved; the chip at the bottom left says which, and
its × goes back to the free view (45°, no frame).

## The shot list

**Shot list…** (the board's "31 · Shot list") renders the ticked saved views as stills in one go,
each in its own frame:

- **On the server:** one export job (`export.shots`) that traces every view on the worker, one after
  another, and keeps going when the dialog closes. It takes one of the project's three render places
  (the 3D render's `MAX_PENDING_RENDERS`), and runs alone among the project's stills and shot lists.
  Its file is a ZIP of PNGs named for their views (`01-hero-exterior.png`); the dialog reads it back
  and shows them. Sizes by the long side: 960, 1440 or 1920 px; qualities 16, 64 or 256 samples a
  pixel, a combination over a still's work budget refused.
- **On this device's GPU** (where the browser has WebGPU): each view traced here in turn, as the GPU
  still is — its glTF export with its levels and lights (views that share them share one export) —
  and saved to the version's exports as it finishes; 1600, 2400 or 3840 px, 64 to 1024 samples.

## Agents

`floorspec_render` takes a saved view in `view` — `plan`, `3d`, or a view's name — and path-traces
it as the photograph it describes (800 px along its long side by default, at most 1280): a few
samples a pixel, denoised, lit by its scene when it has one. A view sets its own camera, cutaway, sky,
time and lights, so those are refused beside it. The API's `GET /render?view=3d&savedView=<name>` is
the same render, and `POST /exports` with `kind: "shots"` the shot list.
