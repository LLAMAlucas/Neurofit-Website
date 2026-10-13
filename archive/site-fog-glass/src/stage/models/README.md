# Body models

`body-male.glb` and `body-female.glb` are from Quaternius's **Universal Base
Characters** (https://quaternius.com/packs/universalbasecharacters.html),
released under **CC0**: free for commercial use, no attribution required.
Credited here anyway.

Stripped to the mesh and its skin weights (no textures, hair or eyes) and
compressed with glTF-Transform. The skeleton uses Unreal-mannequin bone names,
which `lib/retarget.ts` (`UE_RIG`) and `lib/sampleSkeleton.ts` (`JOINT_BONE`)
depend on.

The site ships only the male body. The female one is used by the dev lab
(`/lab/`), which is never part of a production build.
