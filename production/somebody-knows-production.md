# CAR FOX — "SOMEBODY KNOWS"
### :30 brand film — production bible (2026-07-18)

**Logline.** A father and son are one signature away from buying a used car with no
history report. Across town, Car Fox *feels it* — and runs. Played completely
straight, blockbuster-grade, until the charm lands.

**Tagline.** *Know before you buy. CAR FOX.*

**Method.** Locked assets → Seedance 2.0 shots (seedance-clean prompt system),
same pipeline as THE NEPHEW. Every shot is a sealed single-shot prompt; identity
comes from image references, behavior from text.

---

## 1. LOCKED ASSETS

| Tag | Asset | ID | Notes |
|---|---|---|---|
| fox (bust) | Uploaded reference | `e2f08990-56bb-49e5-b93d-ef7acf408629` | media_id (canon face + shirt) |
| fox (full body) | Character sheet | `5af2fcd6-790a-44a8-977a-280a7ce70d72` | job_id — use for any shot showing legs/tail |
| dad | 52, olive field jacket, salt-pepper beard | `87aed074-a471-4efb-9b04-0c329715a414` | v2 recast — v1 `6dce48c0…` REJECTED (chest logo patch). Tiny cuff tab on v2: check close frames before ship |
| son | 19, denim jacket over white tee, dark curls | `867317b9-b998-4375-a522-ad07885b4b29` | plain clothing, no logos |
| seller | 45, navy polo, slicked hair, clipboard | `724da029-ff9b-459b-9081-c2f8dac762dd` | clipboard paper stays blank |
| driveway | Craftsman house + burgundy station wagon, golden hour | `f61115ec-8518-4dd0-84cd-e25c945a8a98` | hero location, shots 1/4/5 |
| street | Downtown canyon, sun down the axis | `f6e85a9e-e4a5-4baf-967b-014af330029a` | the run, shot 3 |
| office | Mid-century study, blinds light, white mug | `3ec6eaee-46a8-48a8-bbeb-6555c9fa8cef` | the sense, shot 2 |

Guardrails carried over from the DevLift ad work: **no readable AI-generated text
in any frame** (blank clipboard paper, wordless phone UI, wordless storefronts).
The only text allowed on screen is the CAR FOX shirt, which is locked by the
uploaded reference. End-card typography is real type added in post, never generated.

In each shot prompt below, `@image1..N` follow the load order of that shot's
`medias` array (listed above each prompt).

---

## 2. FILM STRUCTURE (36s master, 16:9)

| # | Beat | Len | Location | Native audio |
|---|---|---|---|---|
| 1 | The Almost — pen nearly touches paper | 6s | driveway | seller: "She's a beauty. Just sign right here." |
| 2 | The Sense — ears go radar | 6s | office | sub-bass pulse, ceramic clink |
| 3 | The Run — full blockbuster sprint | 8s | street | footfalls, wind, traffic |
| 4 | The Save — paw stops the pen | 8s | driveway | fox: "Did we check its history?" |
| 5 | The Handshake — relief + salute | 8s | driveway | dad: "Thanks, Car Fox." |
| 6 | End card (post, no gen cost) | ~3s | — | VO tag |

**VO (record via ElevenLabs, mix in post — trailer pacing, warm confident read):**
1. over S1: "Every day, somebody falls in love with a used car… without knowing its story."
2. over S2→S3: "Luckily… somebody always knows."
3. over S5/end card: "Get the Car Fox report. Know before you buy."

**End card:** cobalt-blue field sampled from the avatar background, avatar art +
real set type "KNOW BEFORE YOU BUY." / "CAR FOX", built in ffmpeg/HTML like the
NEPHEW end card.

---

## 3. SHOT PROMPTS (Seedance 2.0, 16:9, std)

### SHOT 1 — "The Almost" (6s)
medias: `f61115ec…` (image_references), `6dce48c0…`, `867317b9…`, `724da029…`

```
SCENE CONTEXT
Golden hour on a suburban driveway. A father and his 19-year-old son admire a
gleaming deep-burgundy vintage station wagon while a private seller extends a clipboard and pen.
The son takes the pen and lowers it toward the paper.

ACTIVE REFERENCES
@image1 — the driveway location: craftsman house, burgundy station wagon on concrete,
low warm sun from the left, long shadows. 100% matches the reference.
@image2 — the father: 52, sturdy, salt-and-pepper beard, plain olive field
jacket. 100% matches the reference.
@image3 — the son: 19, lanky, dark curls, plain denim jacket over white tee.
100% matches the reference.
@image4 — the seller: 45, slicked-back hair, plain navy polo, clipboard with
blank white paper and silver pen. 100% matches the reference.

LOCATION MAP
Foreground: the wagon's polished hood catching flare, camera side. Midground:
the three men beside the driver's door — seller nearest camera-right, father and
son camera-left facing him. Background: house porch and tree-lined street soft.
Sun low from camera-left; camera works from the shadow side.

FIRST FRAME / BLOCKING
All three already in frame: son at the driver's door running a hand along the
roofline, father a half-step behind with arms folded, seller presenting the
clipboard chest-high between them.

FORMAT MODE
CUT 1 … CUT 2 … CUT 3 — cuts only at the specified points, the camera does not
cut on its own.

OPTICS
CUT 1: MS 47°. CUT 2: MCU 29° on the clipboard hand-off. CUT 3: ECU 18° on the
pen tip descending toward the blank signature line. No drift mid-segment.

CAMERA
Eye-level, slow 3 km/h push-in through all three cuts, focus riding the pen in
CUT 3. Warm high-latitude filmic look, gentle highlight roll-off.

ACTION
CUT 1 — the son circles the hood grinning, palm gliding along the warm metal;
the seller lifts the clipboard. CUT 2 — the seller says "She's a beauty. Just
sign right here," holding out the silver pen; the son takes it, father leans in.
CUT 3 — the pen tip sinks toward the paper and stops a finger's width above it
as the frame ends.

PERFORMANCE
The son's excitement is muscular: quick eyebrows, bitten lower lip. The father's
smile carries a flicker of doubt — eyes dart once to the odometer, jaw sets.
Seller's grin holds one beat too long. Pore-level skin, living catch-lights.

LIGHTING
Low golden sun from camera-left, 3200K warmth, long raking shadows, soft bounce
into faces from the concrete, flare licking the hood in CUT 1.

AUDIO
Quiet suburb ambience, one distant lawn sprinkler; seller's line in CUT 2,
close and warm.

STYLE
Photoreal premium commercial film, anamorphic feel, fine grain, real time.

POSITIVE LOCKS
The clipboard paper stays blank white in every cut. The station wagon stays deep
burgundy and spotless. Wardrobe stays plain with no logos. The pen never
touches the paper.
```

### SHOT 2 — "The Sense" (6s)
medias: `3ec6eaee…` (image_references), `5af2fcd6…`

```
SCENE CONTEXT
Late afternoon in a warm mid-century study. A tall fox mascot in a white ringer
t-shirt sips coffee at the walnut desk, freezes mid-sip, and is gone by the end
of the shot.

ACTIVE REFERENCES
@image1 — the study: walnut desk, tan leather chair, brass lamp, venetian-blind
light striping the wall, white ceramic mug. 100% matches the reference.
@image2 — the fox: russet fur, white muzzle, white ringer tee with black CAR FOX
text on the chest, bushy white-tipped tail, human height. 100% matches the
reference.

LOCATION MAP
Foreground: desk edge with the mug. Midground: the fox in the chair, three-quarter
to camera. Background: wordless framed car photographs soft. Blinds light from
camera-right; camera on the shadow side.

FIRST FRAME / BLOCKING
The fox mid-sip, mug at his muzzle, eyes half-closed in contentment, tail
draped over the chair arm.

FORMAT MODE
0.0s to 2.5s — first beat. 2.5s HARD CUT. 2.5s to 4.0s — second beat. 4.0s HARD
CUT. 4.0s to 6.0s — third beat. Cuts only at the specified points, the camera
does not cut on its own.

OPTICS
Beat 1: MS 47°. Beat 2: ECU 18° on his left eye. Beat 3: WS 63° of the whole
study. No drift mid-segment.

CAMERA
Beat 1 locked off at desk height. Beat 2 locked off, razor focus on the iris.
Beat 3 locked off wide. Warm filmic latitude, soft highlight roll-off.

ACTION
Beat 1 — he freezes mid-sip; both ears rotate independently toward the window
like radar dishes, one after the other; the fur along his forearms lifts. Beat 2
— extreme close on the amber eye: the pupil snaps narrow, a bright window
catch-light slides across it. Beat 3 — the study is already empty: the leather
chair spinning at 30 rpm, the mug rocking to a stop on the desk, steam curling,
two sheets of blank paper settling to the floor.

PHYSICS
The chair's spin decays naturally with mass; the mug rocks in shrinking arcs;
paper falls with real air resistance; coffee surface ripples once.

LIGHTING
Venetian-blind stripes 3200K across fur and wall, deep cozy shadow pools, lamp
glow warm in the background.

AUDIO
Room tone; a low sub-bass pulse rising through beat 1 and 2; ceramic clink and
chair bearing whir in beat 3.

STYLE
Photoreal premium commercial film, strand-level CGI fur, fine grain, real time.

POSITIVE LOCKS
The fox's tee reads CAR FOX in black on white in beat 1, exactly as the
reference. Both ears stay tall and pointed. The study stays empty of people in
beat 3.
```

### SHOT 3 — "The Run" (8s)
medias: `f6e85a9e…` (image_references), `5af2fcd6…`

```
SCENE CONTEXT
Golden hour in a downtown street canyon. A human-height fox mascot in a white
ringer t-shirt sprints straight down the avenue toward the low sun, weaving
through the sidewalk world at full effort.

ACTIVE REFERENCES
@image1 — the street: long straight avenue, brick and glass walls, sun flaring
down the axis, parked yellow taxi and red hydrant on the right sidewalk. 100%
matches the reference.
@image2 — the fox: russet fur, white muzzle, white ringer tee with black CAR FOX
text, bushy white-tipped tail, digitigrade legs. 100% matches the reference.

LOCATION MAP
Foreground: asphalt streaming past. Midground: the fox on the right sidewalk
running toward camera-background sun. Background: the canyon dissolving into
flare and 20% haze. Sun ahead of him; camera works from his shadow side.

FIRST FRAME / BLOCKING
The fox already at full sprint entering frame-left, body low, tail streaming
level behind him, sun blooming ahead.

FORMAT MODE
CUT 1 … CUT 2 … CUT 3 — cuts only at the specified points, the camera does not
cut on its own.

OPTICS
CUT 1: WS 63° low tracking. CUT 2: MCU 29° tracking alongside. CUT 3: WS 84°
low-angle hero frame. No drift mid-segment.

CAMERA
CUT 1: camera-car track at 30 km/h ten centimeters off the asphalt, the fox
gaining on camera. CUT 2: parallel track at his shoulder height, focus locked
on his face. CUT 3: static low hero angle as he plants a paw on the taxi hood,
slides across it, lands without breaking stride and hurdles the hydrant toward
camera. High-latitude filmic look.

ACTION
He runs at 35 km/h, arms pumping, claws ticking the pavement, ears pinned flat
by speed. In CUT 2 his eyes stay fixed on something far ahead, jaw set. In CUT 3
the taxi's suspension dips as he slides across the hood, one paper coffee cup
kicked spinning, then he clears the hydrant by a hand's width.

PHYSICS
Fur streams and ripples with speed; the tee flutters at the hem; the taxi rocks
on its springs with his weight; the cup tumbles with real spin; dust motes hang
in the compressed golden air.

LIGHTING
Sun dead ahead, 3200K, full lens bloom in the wides, rim-light burning the edge
of his fur, long shadow chasing him across the concrete.

AUDIO
Rapid soft footfalls, wind buffet, one taxi horn doppler, fabric flutter.

STYLE
Photoreal blockbuster action photography, anamorphic flare, fine grain, real
time throughout.

POSITIVE LOCKS
The tee reads CAR FOX in black on white in every cut. The tail keeps its white
tip. He stays on the right sidewalk moving screen-left-to-right in all three
cuts.
```

### SHOT 4 — "The Save" (8s)
medias: `f61115ec…` (image_references), `5af2fcd6…`, `6dce48c0…`, `867317b9…`, `724da029…`

```
SCENE CONTEXT
Golden hour on a suburban driveway beside a burgundy vintage station wagon. A 19-year-old is a
breath from signing a seller's clipboard when a human-height fox mascot arrives
and gently stops the pen with one paw, then asks his question.

ACTIVE REFERENCES
@image1 — the driveway location: craftsman house, burgundy station wagon, low warm sun
from the left. 100% matches the reference.
@image2 — the fox: russet fur, white muzzle, white ringer tee with black CAR FOX
text, bushy white-tipped tail. 100% matches the reference.
@image3 — the father: 52, salt-and-pepper beard, plain olive field jacket. 100%
matches the reference.
@image4 — the son: 19, dark curls, plain denim jacket. 100% matches the
reference.
@image5 — the seller: 45, plain navy polo, clipboard with blank white paper.
100% matches the reference.

LOCATION MAP
Foreground: the clipboard between the group. Midground: son center with the pen,
seller camera-right holding the board, father camera-left. The fox enters from
frame-left along the wagon. Background: porch and lawn soft. Sun from
camera-left; camera on the shadow side.

FIRST FRAME / BLOCKING
ECU on the blank signature line, the pen tip one finger-width above the paper,
the seller's thumb on the board's clip.

FORMAT MODE
0.0s to 2.0s — first beat. 2.0s HARD CUT. 2.0s to 5.0s — second beat. 5.0s HARD
CUT. 5.0s to 8.0s — third beat. Cuts only at the specified points, the camera
does not cut on its own.

OPTICS
Beat 1: ECU 12° on pen and paper. Beat 2: MS 47° group. Beat 3: MCU 29° on the
fox. No drift mid-segment.

CAMERA
Beat 1 locked off. Beat 2 eye-level static two meters back, all four in frame.
Beat 3 slow 2 km/h push on the fox's face. Warm filmic latitude.

ACTION
Beat 1 — the pen descends; a russet furred paw slides flat onto the paper under
the tip, claws neat, and the pen taps fur instead of page. Beat 2 — all three
men startle back half a step; the fox stands calm at the center, one paw still
on the clipboard, slightly winded, chest rising; the son's pen hangs mid-air.
Beat 3 — the fox looks from the wagon to the son and says, warm and even, "Did we
check its history?" One beat of silence; the son slowly lowers the pen; the
father's eyes go to the seller, whose smile tightens.

PERFORMANCE
No panic anywhere — the comedy is in the calm. The fox breathes like a runner
recovering, ears tall, eyes kind. The seller swallows once. Pore-level skin on
the men, strand-level fur on the fox, living catch-lights all around.

LIGHTING
Low golden sun from camera-left, 3200K, rim light on the fox's ears and
shoulders, faces lifted by concrete bounce.

AUDIO
Suburb ambience; the soft pat of paw on paper in beat 1; the fox's single line
in beat 3, close-miked and calm.

STYLE
Photoreal premium commercial film, anamorphic feel, fine grain, real time.

POSITIVE LOCKS
The clipboard paper stays blank white — the signature line stays unsigned. The
tee reads CAR FOX in black on white. The station wagon stays deep burgundy. All four
characters keep the exact faces and wardrobe of their references in every beat.
```

### SHOT 5 — "The Handshake" (8s)
medias: `f61115ec…` (image_references), `5af2fcd6…`, `6dce48c0…`, `867317b9…`

```
SCENE CONTEXT
Golden hour on a suburban driveway beside a burgundy vintage station wagon. A fox mascot shows a
father and son something on a phone; their faces change; the father shakes the
fox's paw with both hands, and the fox gives a two-finger salute and walks off
toward the sun.

ACTIVE REFERENCES
@image1 — the driveway location: craftsman house, burgundy station wagon, low warm sun
from the left. 100% matches the reference.
@image2 — the fox: russet fur, white muzzle, white ringer tee with black CAR FOX
text, bushy white-tipped tail. 100% matches the reference.
@image3 — the father: 52, salt-and-pepper beard, plain olive field jacket. 100%
matches the reference.
@image4 — the son: 19, dark curls, plain denim jacket. 100% matches the
reference.

LOCATION MAP
Foreground: the three of them in a loose triangle by the wagon's hood, fox
center facing the two men. Midground: the wagon. Background: lawn, porch, street
going soft into flare. Sun from camera-left; camera on the shadow side. The
seller is elsewhere; only these three are in frame.

FIRST FRAME / BLOCKING
The fox holds a smartphone up at chest height facing the men, screen a soft
wordless glow of abstract colored blocks; father and son lean in, reading.

FORMAT MODE
CUT 1 … CUT 2 … CUT 3 — cuts only at the specified points, the camera does not
cut on its own.

OPTICS
CUT 1: MCU 29° over-the-shoulder past the fox onto the men. CUT 2: MS 47°
three-shot. CUT 3: WS 63°. No drift mid-segment.

CAMERA
CUT 1 static over the fox's shoulder, phone glow bottom-frame, focus on the
men's faces. CUT 2 eye-level static. CUT 3 slow 2 km/h pull-back and rise as
the fox walks away. Warm filmic latitude.

ACTION
CUT 1 — the men's eyes track down the glowing screen; the son's eyebrows climb;
the father exhales through his nose and looks at the car with new eyes. CUT 2 —
the father takes the fox's paw in both hands and pumps it, saying "Thanks, Car
Fox," the son grinning wide behind him. CUT 3 — the fox pockets the phone, gives
a relaxed two-finger salute off his brow, turns, and walks up the sidewalk into
the low sun, tail swaying, the two men watching him go.

PERFORMANCE
Gratitude played real: the father's double-hand shake is firm and a little too
long, the fox modest, ears easing back, eyes warm. Pore-level skin, strand-level
fur, living catch-lights.

LIGHTING
Low golden sun from camera-left, 3200K, the walk-off in CUT 3 flaring the lens
as he crosses into the light.

AUDIO
Suburb ambience, the father's line in CUT 2, soft footsteps and a bird in CUT 3.

STYLE
Photoreal premium commercial film, anamorphic feel, fine grain, real time.

POSITIVE LOCKS
The phone screen stays a wordless abstract glow with no readable text. The tee
reads CAR FOX in black on white in every cut. The station wagon stays deep burgundy.
Only the fox, the father, and the son appear in this shot.
```

---

## 3b. DAILIES / QC (2026-07-18)

Proof shot: S2 "The Sense" at 720p/6s — job `3d0a2e20-9b6a-432c-8216-80848754dfe5`
(27 cr), saved as `clips/s2-sense-proof-720p.mp4`.
- Light, mood, physics beat (empty chair + airborne paper + rocking mug) all land.
- Timed HARD CUTs followed loosely (no true ECU eye beat) — acceptable; keep
  timecodes as intent, expect drift.
- **Identity drift:** muzzle renders longer/more feral than the mascot reference.
  FIX for all final fox shots: pass BOTH the bust media
  `e2f08990-56bb-49e5-b93d-ef7acf408629` and the full-body sheet `5af2fcd6…` as
  image_references, and add to ACTIVE REFERENCES: "short rounded muzzle, big
  warm eyes, cute mascot proportions, exactly the face of the reference."
- Seedance may return a preset_recommendation notice instead of generating —
  retry with `declined_preset_id` to run the literal prompt.

End card built: `endcard-16x9.png` (real Inter type + fox cutout job `03cd7e53…`
over sampled cobalt #1572CC). Post scaffolding ready: `edit/make_endcard.py`,
`edit/assemble.sh`, fonts in `assets/`.

## 4. BUDGET (Seedance 2.0, std, 16:9)

| Res | Rate | 36s master | +30% retakes |
|---|---|---|---|
| 1080p | 9 cr/s | 324 cr | ~420 cr |
| 720p | 4.5 cr/s | 162 cr | ~210 cr |

Locked assets: ~1 cr total. Balance at kickoff: **135 cr** → full master needs a
top-up (500-pack covers 1080p + retakes) or a 720p compromise.

## 5. POST

1. Trim + conform 5 clips → ffmpeg concat (NEPHEW `edit/assemble.sh` pattern).
2. ElevenLabs VO (3 lines) — trim silence, lay against picture.
3. Music: licensed track or procedural score (NEPHEW `make_music.py` pattern) —
   single build from S2 pulse to S5 resolve.
4. End card: real typography over cobalt field + avatar art, 3s.
5. Deliverables: 16:9 master, 4:5 feed crop, 9:16 cutdown (reframe tool).
