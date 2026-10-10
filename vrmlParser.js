// Minimal VRML 2.0 parser for the specific subset produced by our export pipeline:
//   - Transform { translation x y z  children [ Shape { geometry PointSet {...} } ] }
//   - Transform { translation x y z  children [ Shape { geometry IndexedLineSet {...} } ] }
// Only geometry is read: the viewer draws every model the same way, so Appearance / Material,
// Viewpoint / NavigationInfo / Background are ignored.
// No general scene-graph handling: nested transforms, multiple shapes per transform,
// and unrecognized node types are not supported (not needed for this data).
//
// Loaded as a classic script (not an ES module) so the viewer works from file://;
// exposes window.parseVRML.
(function () {

function findMatchingBracket(text, openIdx, openChar, closeChar) {
  let depth = 1;
  let i = openIdx + 1;
  const len = text.length;
  while (i < len && depth > 0) {
    const c = text[i];
    if (c === openChar) depth++;
    else if (c === closeChar) depth--;
    i++;
  }
  return i - 1; // index of the matching closing bracket
}

// Scans a substring and extracts all numbers, treating '#' as a
// to-end-of-line comment and any run of whitespace/commas as a delimiter.
function tokenizeNumbers(str) {
  const out = [];
  let bufStart = -1;
  let inComment = false;
  const len = str.length;
  for (let i = 0; i <= len; i++) {
    const c = i < len ? str[i] : '\n'; // sentinel flush at end
    if (inComment) {
      if (c === '\n') inComment = false;
      continue;
    }
    if (c === '#') {
      inComment = true;
      if (bufStart !== -1) {
        out.push(parseFloat(str.slice(bufStart, i)));
        bufStart = -1;
      }
      continue;
    }
    const isDelim = c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',';
    if (isDelim) {
      if (bufStart !== -1) {
        out.push(parseFloat(str.slice(bufStart, i)));
        bufStart = -1;
      }
    } else if (bufStart === -1) {
      bufStart = i;
    }
  }
  return out;
}

function extractTranslation(block) {
  const idx = block.indexOf('translation');
  if (idx === -1) return [0, 0, 0];
  const lineEnd = block.indexOf('\n', idx);
  const segment = block.slice(idx + 'translation'.length, lineEnd === -1 ? block.length : lineEnd);
  const nums = tokenizeNumbers(segment);
  return [nums[0] || 0, nums[1] || 0, nums[2] || 0];
}

function extractBracketedField(block, fieldName) {
  const fieldIdx = block.indexOf(fieldName);
  if (fieldIdx === -1) return null;
  const openIdx = block.indexOf('[', fieldIdx);
  if (openIdx === -1) return null;
  const closeIdx = findMatchingBracket(block, openIdx, '[', ']');
  return block.slice(openIdx + 1, closeIdx);
}

function extractPoints(block, translation) {
  const pointSection = extractBracketedField(block, 'point');
  if (pointSection === null) return null;
  const nums = tokenizeNumbers(pointSection);
  const count = Math.floor(nums.length / 3);
  const positions = new Float32Array(count * 3);
  const [tx, ty, tz] = translation;
  for (let i = 0; i < count; i++) {
    positions[i * 3] = nums[i * 3] + tx;
    positions[i * 3 + 1] = nums[i * 3 + 1] + ty;
    positions[i * 3 + 2] = nums[i * 3 + 2] + tz;
  }
  return positions;
}

function extractCoordIndex(block) {
  const section = extractBracketedField(block, 'coordIndex');
  if (section === null) return null;
  const nums = tokenizeNumbers(section);
  const idx = new Int32Array(nums.length);
  for (let i = 0; i < nums.length; i++) idx[i] = Math.round(nums[i]);
  return idx;
}

// Converts a -1-terminated flat list of polyline vertex indices into
// a flat pair list suitable for THREE.LineSegments (consecutive pairs = one edge).
function coordIndexToSegments(coordIndex) {
  let edgeCount = 0;
  let runLength = 0;
  for (let i = 0; i < coordIndex.length; i++) {
    if (coordIndex[i] === -1) {
      if (runLength > 1) edgeCount += runLength - 1;
      runLength = 0;
    } else {
      runLength++;
    }
  }
  if (runLength > 1) edgeCount += runLength - 1;

  const segments = new Uint32Array(edgeCount * 2);
  let segOut = 0;
  let runStart = 0;
  for (let i = 0; i <= coordIndex.length; i++) {
    const v = i < coordIndex.length ? coordIndex[i] : -1;
    if (v === -1) {
      const runLen = i - runStart;
      for (let j = 0; j < runLen - 1; j++) {
        segments[segOut++] = coordIndex[runStart + j];
        segments[segOut++] = coordIndex[runStart + j + 1];
      }
      runStart = i + 1;
    }
  }
  return segments;
}

function parseVRML(text) {
  const transformRe = /Transform\s*\{/g;
  const pointSets = [];
  const lineSets = [];

  let match;
  while ((match = transformRe.exec(text)) !== null) {
    const openBraceIdx = text.indexOf('{', match.index);
    const closeBraceIdx = findMatchingBracket(text, openBraceIdx, '{', '}');
    const block = text.slice(match.index, closeBraceIdx + 1);
    transformRe.lastIndex = closeBraceIdx + 1;

    const translation = extractTranslation(block);
    const lineSetIdx = block.indexOf('IndexedLineSet');
    const pointSetIdx = block.indexOf('PointSet');

    if (lineSetIdx !== -1 && (pointSetIdx === -1 || lineSetIdx < pointSetIdx)) {
      const positions = extractPoints(block, translation);
      const coordIndex = extractCoordIndex(block);
      if (positions && coordIndex) {
        lineSets.push({ positions, segments: coordIndexToSegments(coordIndex) });
      }
    } else if (pointSetIdx !== -1) {
      const positions = extractPoints(block, translation);
      if (positions) {
        pointSets.push({ positions });
      }
    }
    // Any other node type inside a Transform's children is skipped silently.
  }

  return { pointSets, lineSets };
}

window.parseVRML = parseVRML;
})();
