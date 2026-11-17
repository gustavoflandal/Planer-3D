/* Syncrofin 3D Planner — WebGL view (Three.js r170, MIT, in assets/vendor).

   Draws the plan the way a loading report looks: cardboard boxes with the
   item name printed on their faces and a "this way up" mark, dark edges, a
   cargo space with corrugated walls cut open towards the viewer, a
   checker-plate floor, and the vehicle itself — chassis, wheels at the axle
   positions of the cargo space, the cab of a lorry or the tractor pulling a
   semitrailer — with soft shadows on the ground.

   The planner (app.js) stays in charge: it packs, keeps the camera angles and
   the 2D canvas on top for the pointer and for accessibility, and calls
   SyncrofinScene.update() after every plan and render() on every redraw. If
   WebGL is missing the planner keeps its own 2D drawing.

   Coordinates: the planner works in mm with x from the front wall to the rear,
   y up and z from the left wall to the right. Three.js is right-handed, so a
   point (x, y, z) becomes (x, y, -z) in metres; that keeps the left side of
   the vehicle on its left and every label readable. */

import * as THREE from './vendor/three.module.min.js';

const MM = 0.001;

const S = () => window.SyncrofinSpaces;

/* ------------------------------------------------------------------ setup --- */
let renderer = null;
let scene = null;
let camera = null;
let sun = null;
let world = null; /* everything rebuilt on update() */
let host = null; /* the planner's 2D canvas, which the GL canvas sits under */
let glCanvas = null;
let bounds = null; /* { min, max } of the vehicle and cargo, in metres */
let boxGroups = []; /* { id, mesh, materials } for the selection highlight */
let lastSelected = undefined;
const textureCache = new Map();

function attach(canvas2d) {
  try {
    host = canvas2d;
    glCanvas = document.createElement('canvas');
    glCanvas.className = 'gl-view';
    glCanvas.setAttribute('aria-hidden', 'true');
    host.parentNode.insertBefore(glCanvas, host);
    renderer = new THREE.WebGLRenderer({
      canvas: glCanvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true /* the report prints the view */
    });
  } catch (e) {
    if (glCanvas && glCanvas.parentNode) glCanvas.parentNode.removeChild(glCanvas);
    renderer = null;
    return false;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(30, 1, 0.1, 600);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa1a8, 2.1));
  sun = new THREE.DirectionalLight(0xffffff, 2.3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  sun.shadow.radius = 3;
  scene.add(sun);
  scene.add(sun.target);

  /* the ground only shows the shadows; the colour comes from the page */
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.ShadowMaterial({ opacity: 0.22 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  api.active = true;
  document.documentElement.classList.add('gl-ready');
  return true;
}

/* -------------------------------------------------------------- textures --- */
function canvas2(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function srgb(tex) {
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return tex;
}

/* Breaks a label into lines no wider than maxW, splitting long words. */
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const push = (w) => {
    if (ctx.measureText(w).width <= maxW) return [w];
    const parts = [];
    let cur = '';
    for (const ch of w) {
      if (ctx.measureText(cur + ch).width > maxW && cur) {
        parts.push(cur);
        cur = ch;
      } else cur += ch;
    }
    if (cur) parts.push(cur);
    return parts;
  };
  words.forEach((w) => {
    const tryLine = line ? line + ' ' + w : w;
    if (ctx.measureText(tryLine).width <= maxW) {
      line = tryLine;
      return;
    }
    if (line) lines.push(line);
    const parts = push(w);
    line = parts.pop();
    parts.forEach((p) => lines.push(p));
  });
  if (line) lines.push(line);
  return lines;
}

/* "This way up": two arrows over a bar, in a square. */
function upMark(ctx, x, y, s, ink) {
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = Math.max(1, s * 0.07);
  ctx.strokeRect(x, y, s, s);
  const arrow = (cx) => {
    ctx.beginPath();
    ctx.moveTo(cx, y + s * 0.18);
    ctx.lineTo(cx - s * 0.13, y + s * 0.38);
    ctx.lineTo(cx + s * 0.13, y + s * 0.38);
    ctx.closePath();
    ctx.fill();
    ctx.fillRect(cx - s * 0.035, y + s * 0.36, s * 0.07, s * 0.36);
  };
  arrow(x + s * 0.33);
  arrow(x + s * 0.67);
  ctx.fillRect(x + s * 0.15, y + s * 0.78, s * 0.7, s * 0.07);
  ctx.restore();
}

/* One face of a cardboard box: colour, a little grain, a darker foot, a
   dark edge, the item's name and, on the sides, the "this way up" mark. */
function boxFace(hex, name, wmm, hmm, side) {
  const key = [hex, name, Math.round(wmm), Math.round(hmm), side].join('|');
  if (textureCache.has(key)) return textureCache.get(key);

  const scale = Math.min(0.3, 512 / Math.max(wmm, hmm, 1)); /* px per mm */
  const W = Math.max(48, Math.round(wmm * scale));
  const H = Math.max(48, Math.round(hmm * scale));
  const c = canvas2(W, H);
  const g = c.getContext('2d');

  g.fillStyle = hex;
  g.fillRect(0, 0, W, H);

  /* grain */
  let seed = W * 7919 + H * 104729 + name.length;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < (W * H) / 30; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.05)';
    g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
  }

  /* light from above, a darker foot on the sides */
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(0,0,0,0.10)');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  if (side === 'side') {
    g.fillStyle = 'rgba(0,0,0,0.13)';
    g.fillRect(0, H * 0.86, W, H * 0.14);
  }

  /* edge */
  const edge = Math.max(2, Math.round(Math.min(W, H) * 0.025));
  g.strokeStyle = 'rgba(20,24,28,0.75)';
  g.lineWidth = edge;
  g.strokeRect(edge / 2, edge / 2, W - edge, H - edge);

  /* label */
  const ink = 'rgba(22,24,26,0.85)';
  const pad = Math.max(4, Math.min(W, H) * 0.08);
  const markS = side === 'side' && Math.min(W, H) > 70 ? Math.min(W, H) * 0.17 : 0;
  if (markS) upMark(g, W - pad - markS, pad, markS, ink);

  let font = Math.min(H * 0.26, W * 0.24, 150 * scale);
  const maxW = W - 2 * pad;
  const maxH = H - 2 * pad - markS * 0.6;
  const longest = Math.max(...String(name).split(/\s+/).map((s) => s.length), 1);
  let lines = [];
  for (; font >= 8; font *= 0.88) {
    g.font = '700 ' + font.toFixed(1) + 'px Arial, Helvetica, sans-serif';
    lines = wrap(g, name, maxW);
    /* a smaller font before a word is cut in two, down to a readable size */
    const cut = lines.some((ln) => ln.length < longest && !/\s/.test(ln) && !String(name).split(/\s+/).includes(ln));
    if (cut && font * 0.88 >= 11) continue;
    if (lines.length * font * 1.08 <= maxH && lines.length <= 4) break;
  }
  if (font >= 8 && lines.length) {
    g.fillStyle = ink;
    g.textBaseline = 'top';
    const blockH = lines.length * font * 1.08;
    let y = Math.max(pad + markS * 0.6, (H - blockH) / 2);
    lines.forEach((ln) => {
      g.fillText(ln, pad, y);
      y += font * 1.08;
    });
  }

  const tex = srgb(new THREE.CanvasTexture(c));
  textureCache.set(key, tex);
  return tex;
}

let corrugated = null;
function wallTexture(repeatU, repeatV) {
  if (!corrugated) {
    const c = canvas2(128, 64);
    const g = c.getContext('2d');
    for (let x = 0; x < 128; x++) {
      const v = 0.5 + 0.5 * Math.sin((x / 128) * Math.PI * 4);
      const shade = Math.round(214 + v * 30);
      g.fillStyle = 'rgb(' + shade + ',' + shade + ',' + (shade + 3) + ')';
      g.fillRect(x, 0, 1, 64);
    }
    /* a little weathering */
    for (let i = 0; i < 260; i++) {
      g.fillStyle = 'rgba(90,90,90,' + (Math.random() * 0.05).toFixed(3) + ')';
      g.fillRect(Math.random() * 128, Math.random() * 64, 1 + Math.random() * 3, 1 + Math.random() * 10);
    }
    corrugated = c;
  }
  const t = srgb(new THREE.CanvasTexture(corrugated));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  return t;
}

let plate = null;
function floorTexture(l, w) {
  if (!plate) {
    const c = canvas2(128, 128);
    const g = c.getContext('2d');
    g.fillStyle = '#b8bdc2';
    g.fillRect(0, 0, 128, 128);
    /* checker plate: short raised slots in alternating directions */
    for (let y = 0; y < 128; y += 16) {
      for (let x = 0; x < 128; x += 16) {
        const flip = ((x + y) / 16) % 2 === 0;
        g.save();
        g.translate(x + 8, y + 8);
        g.rotate(flip ? Math.PI / 4 : -Math.PI / 4);
        g.fillStyle = 'rgba(255,255,255,0.45)';
        g.fillRect(-5, -1.6, 10, 2);
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.fillRect(-5, 0.6, 10, 1.2);
        g.restore();
      }
    }
    plate = c;
  }
  const t = srgb(new THREE.CanvasTexture(plate));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(l / 0.6, w / 0.6);
  return t;
}

/* --------------------------------------------------------------- helpers --- */
function mat(color, opts) {
  return new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.75, metalness: 0.05 }, opts || {}));
}

function box(group, w, h, d, x, y, z, material, shadow = true) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  group.add(m);
  return m;
}

/* centre of a planner box (mm) → three.js position (m) */
function toWorld(x, y, z, deck) {
  return new THREE.Vector3(x * MM, deck + y * MM, -z * MM);
}

const tireMat = () => mat(0x1d1f22, { roughness: 0.92 });
const rimMat = () => mat(0xcfd3d7, { metalness: 0.55, roughness: 0.35 });

function wheel(group, x, zCentre, r, width, dual) {
  const tire = new THREE.CylinderGeometry(r, r, width, 32);
  tire.rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(r * 0.56, r * 0.56, width + 0.012, 24);
  rim.rotateX(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(r * 0.2, r * 0.2, width + 0.03, 16);
  hub.rotateX(Math.PI / 2);
  const tm = tireMat();
  const rm = rimMat();
  const hm = mat(0x6e747a, { metalness: 0.5, roughness: 0.4 });
  const offsets = dual ? [-width * 0.55, width * 0.55] : [0];
  offsets.forEach((o) => {
    [tire, rim, hub].forEach((geo, i) => {
      const m = new THREE.Mesh(geo, [tm, rm, hm][i]);
      m.position.set(x, r, zCentre + o);
      m.castShadow = i === 0;
      m.receiveShadow = true;
      group.add(m);
    });
  });
}

/* An axle: wheels on both sides, at the track (bitola) apart. */
function axle(group, x, centreZ, track, r, dual) {
  const half = track / 2;
  const width = dual ? 0.27 : 0.32;
  wheel(group, x, centreZ + half, r, width, dual);
  wheel(group, x, centreZ - half, r, width, dual);
  box(group, 0.12, 0.12, track - 0.2, x, r, centreZ, mat(0x2f3337));
}

/* A cab: front at xFront, rear at xRear, floor at baseY, roof at topY.
   spoiler: a roof deflector, as tractors carry to meet a taller trailer. */
function cab(group, xFront, xRear, baseY, topY, width, centreZ, colour, spoiler) {
  const paint = mat(colour, { roughness: 0.38, metalness: 0.3 });
  const glass = mat(0x1d2a35, { roughness: 0.08, metalness: 0.7 });
  const dark = mat(0x2a2d31, { roughness: 0.8 });
  const len = xRear - xFront;
  const h = topY - baseY;
  /* lower body, then the upper cab set back a little under a sloping screen */
  box(group, len, h * 0.62, width, xFront + len / 2, baseY + h * 0.31, centreZ, paint);
  const lean = Math.min(0.22, len * 0.09);
  box(group, len - lean, h * 0.38, width * 0.97, xFront + lean + (len - lean) / 2, baseY + h * 0.81, centreZ, paint);
  /* the sloping windscreen bridges the step */
  const screenH = h * 0.36;
  const screen = box(group, 0.03, Math.hypot(screenH, lean), width * 0.88, xFront + lean / 2 + 0.01, baseY + h * 0.8, centreZ, glass, false);
  screen.rotation.z = -Math.atan2(lean, screenH);
  /* sun visor and roof */
  box(group, 0.16, 0.06, width * 0.9, xFront + lean - 0.02, baseY + h * 0.99, centreZ, dark);
  if (spoiler) {
    const sp = box(group, len * 0.55, 0.05, width * 0.9, xFront + lean + len * 0.3, topY + 0.22, centreZ, paint);
    sp.rotation.z = -0.32;
    [1, -1].forEach((s) => box(group, len * 0.5, 0.42, 0.03, xFront + lean + len * 0.34, topY + 0.2, centreZ + s * width * 0.44, paint));
  }
  [1, -1].forEach((s) => {
    box(group, len * 0.34, h * 0.24, 0.03, xFront + len * 0.26, baseY + h * 0.74, centreZ + s * (width * 0.48 + 0.006), glass, false);
    /* mirror */
    box(group, 0.06, 0.32, 0.08, xFront + 0.1, baseY + h * 0.7, centreZ + s * (width / 2 + 0.16), dark);
  });
  /* grille, bumper and lights */
  box(group, 0.04, h * 0.26, width * 0.6, xFront - 0.015, baseY + h * 0.36, centreZ, dark, false);
  box(group, 0.22, 0.32, width * 1.0, xFront + 0.08, baseY + 0.06, centreZ, mat(0x3a3e43, { roughness: 0.6 }));
  [1, -1].forEach((s) => {
    box(group, 0.05, 0.12, 0.34, xFront - 0.02, baseY + 0.3, centreZ + s * width * 0.36,
      mat(0xfff6d8, { emissive: 0x6b6450, roughness: 0.3 }), false);
  });
  /* step under the door */
  box(group, len * 0.3, 0.08, width * 1.04, xFront + len * 0.3, baseY - 0.2, centreZ, dark);
}

/* ------------------------------------------------------------- the build --- */
function disposeWorld() {
  if (!world) return;
  world.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    ms.forEach((m) => {
      if (m.map && !isCached(m.map)) m.map.dispose();
      m.dispose();
    });
  });
  scene.remove(world);
  world = null;
}

function isCached(tex) {
  for (const t of textureCache.values()) if (t === tex) return true;
  return false;
}

function deckHeight(kind, typeId) {
  if (kind === 'box') return 0.16;
  if (/^flatbed/.test(typeId)) return 1.32;
  if (kind === 'semi') return 1.26;
  return 1.12;
}

function update(data) {
  if (!renderer) return;
  disposeWorld();
  if (textureCache.size > 300) {
    textureCache.forEach((t) => t.dispose());
    textureCache.clear();
  }
  world = new THREE.Group();
  boxGroups = [];
  lastSelected = undefined;

  const sp = data.space;
  const t = S().typeOf(sp.type) || { kind: 'box', id: 'container' };
  const kind = t.kind;
  const flat = /^flatbed/.test(t.id);
  const L = sp.l * MM;
  const W = sp.w * MM;
  const H = sp.h * MM;
  const deck = deckHeight(kind, t.id);
  const cz = -W / 2; /* centre line of the vehicle in three.js z */
  const roles = S().roles(sp.type);
  const axles = sp.axles || [];
  const track = (sp.track > 0 ? sp.track : sp.w * 0.84) * MM;
  const wheelR = 0.5;

  /* floor */
  const floorMat = mat(0xffffff, { map: floorTexture(L, W), roughness: 0.6, metalness: 0.2 });
  box(world, L, 0.06, W, L / 2, deck - 0.03, cz, floorMat);

  /* walls, open towards the viewer: inner faces only, no roof */
  if (!flat) {
    const wallMats = [
      mat(0xffffff, { map: wallTexture(W / 0.3, 1), side: THREE.BackSide }), /* +x rear doors */
      mat(0xffffff, { map: wallTexture(W / 0.3, 1), side: THREE.BackSide }), /* -x front wall */
      new THREE.MeshBasicMaterial({ visible: false }), /* roof */
      new THREE.MeshBasicMaterial({ visible: false }), /* floor drawn above */
      mat(0xffffff, { map: wallTexture(L / 0.3, 1), side: THREE.BackSide }),
      mat(0xffffff, { map: wallTexture(L / 0.3, 1), side: THREE.BackSide })
    ];
    const walls = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), wallMats);
    walls.position.set(L / 2, deck + H / 2, cz);
    walls.receiveShadow = true;
    world.add(walls);
  }
  /* frame of the cargo space */
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)),
    new THREE.LineBasicMaterial({ color: 0x5c5b5b, transparent: true, opacity: flat ? 0.35 : 0.8 })
  );
  frame.position.set(L / 2, deck + H / 2, cz);
  world.add(frame);
  if (flat) {
    /* stakes along the sides of a platform */
    const stake = mat(0x4b5056);
    for (let x = 0.4; x < L; x += 1.2) {
      [0, -W].forEach((z) => box(world, 0.06, 0.5, 0.06, x, deck + 0.25, z, stake));
    }
  }

  /* chassis and running gear */
  const steel = mat(0x33373c, { roughness: 0.6, metalness: 0.3 });
  const bodyColour = 0x2f63b3;
  let minX = 0;
  let maxX = L;
  if (kind !== 'box') {
    const rails = [cz + W * 0.22, cz - W * 0.22];
    let railFront = 0.2;
    if (kind === 'lorry') railFront = Math.min(0, (axles[0] ? axles[0].dist * MM : -1.4) - 1.0);
    const railLen = L - 0.1 - railFront;
    rails.forEach((z) => box(world, railLen, 0.24, 0.12, railFront + railLen / 2, deck - 0.2, z, steel));
    box(world, L, 0.08, W, L / 2, deck - 0.1, cz, mat(0x45494e)); /* side skirt / cross members */

    axles.forEach((a, i) => {
      const x = a.dist * MM;
      if (roles[i] && roles[i].role === 'kingpin') {
        const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.12, 12), steel);
        pin.position.set(x, deck - 0.2, cz);
        world.add(pin);
        return;
      }
      const front = roles[i] && roles[i].role === 'front';
      axle(world, x, cz, track, wheelR, !front);
      minX = Math.min(minX, x - wheelR);
      maxX = Math.max(maxX, x + wheelR);
      /* mudguard over the wheels of a trailer body */
      if (kind !== 'lorry' || !front) {
        [cz + track / 2, cz - track / 2].forEach((z) => box(world, 1.15, 0.04, 0.62, x, wheelR * 2 + 0.08, z, mat(0x2a2d31)));
      }
    });

    if (kind === 'semi') {
      /* landing gear behind the kingpin */
      const lg = (axles[0] ? axles[0].dist * MM : 1.7) + 1.3;
      [cz + W * 0.36, cz - W * 0.36].forEach((z) => {
        box(world, 0.12, deck - 0.25, 0.12, lg, (deck - 0.25) / 2 + 0.05, z, steel);
        box(world, 0.3, 0.05, 0.3, lg, 0.03, z, steel);
      });
    }
    if (kind === 'trailer' && axles[0]) {
      /* drawbar */
      const x0 = axles[0].dist * MM;
      const tip = x0 - 2.2;
      [1, -1].forEach((s) => {
        const len = Math.hypot(2.2, W * 0.3);
        const bar = box(world, len, 0.1, 0.1, x0 - 1.1, wheelR + 0.15, cz + s * W * 0.15, steel);
        bar.rotation.y = -s * Math.atan2(W * 0.3, 2.2); /* the two bars meet at the eye in front */
      });
      box(world, 0.3, 0.12, 0.2, tip, wheelR + 0.15, cz, steel);
      minX = Math.min(minX, tip - 0.2);
    }
    if (kind === 'lorry') {
      const fa = axles[0] ? axles[0].dist * MM : -1.4;
      const xFront = fa - 1.25;
      cab(world, xFront, Math.min(-0.12, xFront + 2.3), 1.05, Math.min(deck + H + 0.05, 3.9), W * 0.98, cz, bodyColour);
      minX = Math.min(minX, xFront - 0.1);
    }
  }

  /* the tractor carrying a semitrailer */
  const tr = data.tractor;
  if (kind === 'semi' && tr && tr.axles && tr.axles.length >= 2) {
    const kp = axles[0] ? axles[0].dist * MM : 1.7;
    const trRoles = S().roles(tr.type);
    const ttrack = (tr.track > 0 ? tr.track : 2050) * MM;
    const tx = tr.axles.map((a) => kp + a.dist * MM);
    const xFront = tx[0] - 1.3;
    const xRearCab = Math.min(xFront + 2.35, kp - 0.9);
    const chassisTop = deck - 0.16;
    box(world, tx[tx.length - 1] + 0.7 - xFront, 0.26, 0.9, (xFront + tx[tx.length - 1] + 0.7) / 2, chassisTop - 0.25, cz, steel);
    /* fifth wheel */
    const fifth = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 28), mat(0x23262a, { metalness: 0.4 }));
    fifth.position.set(kp, chassisTop - 0.05, cz);
    fifth.castShadow = true;
    world.add(fifth);
    tr.axles.forEach((a, i) => {
      const front = trRoles[i] && trRoles[i].role === 'front';
      axle(world, tx[i], cz, ttrack, wheelR, !front);
      if (!front) [cz + ttrack / 2, cz - ttrack / 2].forEach((z) => box(world, 1.0, 0.04, 0.62, tx[i], wheelR * 2 + 0.08, z, mat(0x2a2d31)));
    });
    cab(world, xFront, xRearCab, 1.05, 3.6, 2.45, cz, bodyColour, true);
    /* fuel tank and air tanks along the chassis */
    box(world, 1.0, 0.55, 0.55, xRearCab + 0.6, 0.85, cz + 0.85, mat(0xb9bec4, { metalness: 0.6, roughness: 0.3 }));
    minX = Math.min(minX, xFront - 0.1);
  }

  /* cargo */
  const names = data.names || {};
  const palette = data.palette || {};
  const groups = new Map();
  (data.placed || []).forEach((b) => {
    const key = b.id + '|' + b.l + '|' + b.w + '|' + b.h;
    if (!groups.has(key)) groups.set(key, { id: b.id, color: b.color, l: b.l, w: b.w, h: b.h, boxes: [] });
    groups.get(key).boxes.push(b);
  });
  const edgePos = [];
  const m4 = new THREE.Matrix4();
  groups.forEach((g) => {
    const hex = palette[g.color] || '#5fc2ea';
    const name = names[g.id] || '';
    /* BoxGeometry face order: +x, -x, +y, -y, +z, -z; sizes (w × h) per face */
    const faces = [
      [g.w, g.h, 'side'], [g.w, g.h, 'side'],
      [g.l, g.w, 'top'], [g.l, g.w, 'top'],
      [g.l, g.h, 'side'], [g.l, g.h, 'side']
    ];
    const materials = faces.map((f, i) =>
      i === 3
        ? mat(hex, { roughness: 0.9 })
        : new THREE.MeshStandardMaterial({ map: boxFace(hex, name, f[0], f[1], f[2]), roughness: 0.88, metalness: 0 })
    );
    const geo = new THREE.BoxGeometry(g.l * MM, g.h * MM, g.w * MM);
    const mesh = new THREE.InstancedMesh(geo, materials, g.boxes.length);
    g.boxes.forEach((b, i) => {
      const c = toWorld(b.x + b.l / 2, b.y + b.h / 2, b.z + b.w / 2, deck);
      m4.makeTranslation(c.x, c.y, c.z);
      mesh.setMatrixAt(i, m4);
      /* edges */
      const x0 = b.x * MM;
      const x1 = (b.x + b.l) * MM;
      const y0 = deck + b.y * MM;
      const y1 = deck + (b.y + b.h) * MM;
      const z0 = -b.z * MM;
      const z1 = -(b.z + b.w) * MM;
      const P = [
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]
      ];
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach((e) => {
        edgePos.push(...P[e[0]], ...P[e[1]]);
      });
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    world.add(mesh);
    boxGroups.push({ id: g.id, materials });
  });
  if (edgePos.length) {
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(edgePos, 3));
    world.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x15181b, transparent: true, opacity: 0.7 })));
  }

  scene.add(world);

  const top = Math.max(deck + H, kind === 'lorry' || tr ? 3.9 : 0);
  bounds = {
    min: new THREE.Vector3(minX, 0, -W - 0.4),
    max: new THREE.Vector3(maxX, top, 0.4)
  };

  /* the sun from the front left, high; its shadow box fits the vehicle */
  const centre = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
  const size = bounds.max.clone().sub(bounds.min);
  const reach = Math.max(size.x, size.z) * 0.75 + 3;
  sun.position.set(centre.x - reach * 0.55, reach * 1.4, centre.z + reach * 0.9);
  sun.target.position.copy(centre);
  const sc = sun.shadow.camera;
  sc.left = -reach;
  sc.right = reach;
  sc.top = reach;
  sc.bottom = -reach;
  sc.near = 0.5;
  sc.far = reach * 4;
  sc.updateProjectionMatrix();
}

/* -------------------------------------------------------------- selection --- */
function highlight(selected) {
  if (selected === lastSelected) return;
  lastSelected = selected;
  boxGroups.forEach((g) => {
    const on = selected !== null && selected !== undefined && g.id === selected;
    g.materials.forEach((m) => {
      if (m.emissive) m.emissive.setHex(on ? 0x3a3a3a : 0x000000);
    });
  });
}

/* ----------------------------------------------------------------- render --- */
/* view: { az, elev, zoom } from the planner — the same angles its 2D drawing
   uses, so the view buttons keep their meaning. */
function render(view, selected) {
  if (!renderer || !host || !bounds) return;
  const w = host.clientWidth;
  const h = host.clientHeight;
  if (!w || !h) return;
  glCanvas.style.left = host.offsetLeft + 'px';
  glCanvas.style.top = host.offsetTop + 'px';
  glCanvas.style.width = w + 'px';
  glCanvas.style.height = h + 'px';
  const pr = renderer.getPixelRatio();
  if (glCanvas.width !== Math.round(w * pr) || glCanvas.height !== Math.round(h * pr)) {
    renderer.setSize(w, h, false);
  }

  highlight(selected);

  const centre = bounds.min.clone().add(bounds.max).multiplyScalar(0.5);
  const radius = bounds.max.clone().sub(bounds.min).length() / 2;
  camera.aspect = w / h;
  const tanV = Math.tan((camera.fov * Math.PI) / 360) * 0.94;
  const tanH = tanV * camera.aspect;
  const ce = Math.cos(view.elev);
  /* planner angles are in its own axes (z to the right); three.js z is mirrored */
  const dir = new THREE.Vector3(ce * Math.cos(view.az), Math.sin(view.elev), -ce * Math.sin(view.az)).normalize();
  camera.up.set(0, 1, 0);
  if (view.elev > 1.5) camera.up.set(-1, 0, 0); /* straight down: keep the front on the left */

  /* Tight fit: the nearest distance at which every corner of the vehicle is
     inside the frame, then the planner's zoom on top. */
  camera.position.copy(centre).addScaledVector(dir, 10);
  camera.lookAt(centre);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  let fit = 0;
  for (let i = 0; i < 8; i++) {
    const c = new THREE.Vector3(
      i & 1 ? bounds.max.x : bounds.min.x,
      i & 2 ? bounds.max.y : bounds.min.y,
      i & 4 ? bounds.max.z : bounds.min.z
    ).sub(centre);
    const toward = c.dot(dir); /* how far the corner sits towards the camera */
    fit = Math.max(fit, toward + Math.abs(c.dot(right)) / tanH, toward + Math.abs(c.dot(up)) / tanV);
  }
  const dist = fit / (view.zoom || 1);
  camera.position.copy(centre).addScaledVector(dir, dist);
  camera.lookAt(centre);
  camera.near = Math.max(0.05, dist - radius * 2.5);
  camera.far = dist + radius * 3;
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
}

const api = { active: false, attach, update, render };
window.SyncrofinScene = api;

function boot() {
  const c = document.getElementById('view');
  if (!c || !window.SyncrofinApp || api.active) return;
  if (attach(c) && window.SyncrofinApp.redraw) window.SyncrofinApp.redraw();
}

/* Module scripts run before DOMContentLoaded; the planner starts on it. */
if (document.readyState === 'complete') boot();
else window.addEventListener('DOMContentLoaded', boot);
