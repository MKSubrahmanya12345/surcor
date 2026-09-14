# CAD test fixtures

Three STEP files used by `bun test tests/prompt7`. They are **not** hand-written:
each was exported by a real geometry kernel, so the topology fingerprints the
tests assert (`validateStepFile`, the placeholder guard, the GLB conversion) are
checked against genuine OpenCASCADE output rather than an imitation.

Kernel: `build123d 0.11.1` on `cadquery-ocp-novtk 7.9.3.1.1` (OpenCASCADE 7.9.3).

| File | Geometry | Why it is here |
|---|---|---|
| `flange.step` | Ø80 disc, 10 mm thick, Ø30 bore, 4 × Ø8 bolt holes on a Ø60 circle → 1 solid, 8 faces (2 planar, 6 cylindrical) | the "real featureful part" case: must pass validation and must convert to a GLB with hundreds of triangles |
| `plate.step` | bare 50 × 50 × 6 box → 1 solid, 6 planar faces | the exact placeholder shape Forge must refuse for a featureful request (and accept for "a 50x50x6 mm base plate") |
| `bolt.step` | hex head, across-flats 8 mm, 5.3 mm tall + Ø8 × 20 mm shank → 15 faces | a catalogue-style fastener with both planar and curved faces |

Regenerate with:

```python
from build123d import *
import math

out = "tests/prompt7/fixtures"

holes = Circle(15)
for i in range(4):
    holes = holes + Circle(4).moved(Location(Vector(30 * math.cos(i * math.pi / 2),
                                                      30 * math.sin(i * math.pi / 2), 0)))
flange = extrude(Circle(40) - holes, amount=10)
export_step(flange, f"{out}/flange.step")

plate = extrude(Rectangle(50, 50), amount=6)
export_step(plate, f"{out}/plate.step")

pts = [(4 / math.cos(math.pi / 6) * math.cos(a * math.pi / 3),
        4 / math.cos(math.pi / 6) * math.sin(a * math.pi / 3)) for a in range(6)]
bolt = extrude(Polygon(*pts), amount=5.3) + Cylinder(4.0, 20.0).moved(Location(Vector(0, 0, 15.3)))
export_step(bolt, f"{out}/bolt.step")
```

On a headless Linux box `libTKOpenGl` needs `libGL.so.1`; if only the GL symbols
are missing, a no-op stub directory on `LD_LIBRARY_PATH` is enough (STEP export
never calls into GL).
