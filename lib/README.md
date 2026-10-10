# Vendored libraries

All MIT-licensed, loaded as classic `<script>` tags (no ES modules, no CDN) so the viewer
also works when `index.html` is opened straight from disk (`file://`), where browsers
refuse to load module scripts.

| File | Source | License |
|---|---|---|
| `pako.min.js` | pako 2.1.0, `dist/pako.min.js` | MIT and Zlib |
| `three.classic.js` | three.js r160 (`three@0.160.0`), `build/three.module.js` | MIT |
| `OrbitControls.classic.js` | three.js r160, `examples/jsm/controls/OrbitControls.js` | MIT |

The two three.js files are the upstream ES modules converted mechanically:

- `three.classic.js`: the module body wrapped in `(function () { ... })();`, with its final
  `export { ... };` statement replaced by `window.THREE = { ... };`.
- `OrbitControls.classic.js`: wrapped the same way, with `import { ... } from 'three';`
  replaced by `const { ... } = window.THREE;` and `export { OrbitControls };` by
  `window.THREE.OrbitControls = OrbitControls;`.

No other lines were changed. To update, get the same two files from the new three.js release
and repeat those replacements.
