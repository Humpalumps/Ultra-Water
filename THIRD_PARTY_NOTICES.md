# Third-party notices

Ultra Water is MIT licensed (see [LICENSE](LICENSE)). A few small pieces of its code are adapted from the MIT-licensed projects below. Their copyright notices are kept here, as their licences require. The MIT licence text that applies to each of them is at the end of this file.

Runtime dependencies (three.js, lil-gui) are installed from npm and carry their own licences in `node_modules`. `npm run build` writes their licence texts to `dist/licenses.md` and copies this file to `dist/`, so both ship with every build.

## three.js

- Source: https://github.com/mrdoob/three.js
- Used in: `src/scene/sky.js` (cloud layer, adapted from `Sky.js`) and `src/engine/PostFX.js` (AgX tone mapping, same maths as three's `AgXToneMapping` chunk. That chunk is itself based on Filament's AgX, which follows Blender's).
- Copyright © 2010-2026 three.js authors
- MIT License

## Hash without Sine (Dave Hoskins)

- Source: https://www.shadertoy.com/view/4djSRW
- Used in: `src/engine/PostFX.js` (`hash33`), `src/scene/sky.js` (`gradient`), `src/scene/terrain.js` (`th`, `th3`), `src/water/OceanSurface.js` (`hash12`, shared with `src/water/Spray.js`) and `src/water/bakeTextures.js` (`hash22`)
- Copyright (c) 2014 David Hoskins
- MIT License

## UnrealEngineSkyAtmosphere (Sébastien Hillaire)

- Source: https://github.com/sebh/UnrealEngineSkyAtmosphere
- Used in: `src/scene/atmosphere.js`, which follows the structure of this reference implementation of Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique".
- Copyright (c) 2020 Epic Games, Inc.
- MIT License

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
