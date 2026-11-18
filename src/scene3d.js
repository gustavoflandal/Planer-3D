/* Syncrofin 3D Planner — WebGL view (Three.js r170, MIT, in assets/vendor).

   Draws the plan the way a loading report looks: cardboard boxes with the
   item name printed on their faces and a "this way up" mark, dark edges, a
   cargo space cut open towards the viewer (corrugated walls for a container,
   white panels for a van body), a checker-plate floor, and the vehicle
   itself — chassis, wheels at the axle positions of the cargo space, side
   guards, the silver high-roof cab of a lorry or of the tractor pulling a
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
const CAB_COLOUR = 0x8e9297; /* silver grey */

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
let studio = null; /* environment map the vehicle's paint and glass reflect */
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
  studio = makeStudio(renderer);

  api.active = true;
  document.documentElement.classList.add('gl-ready');
  return true;
}

/* A soft photo studio, only for reflections: a bright sky, a grey horizon
   line, a darker floor and a soft box overhead. Without it metallic paint
   looks flat and dark. */
function makeStudio(r) {
  try {
    const pmrem = new THREE.PMREMGenerator(r);
    const env = new THREE.Scene();
    const sky = new THREE.SphereGeometry(20, 32, 16);
    const pos = sky.attributes.position;
    const colours = [];
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / 20;
      const v = y >= 0 ? 0.74 + 0.26 * Math.pow(y, 0.6) : 0.5 - 0.28 * Math.pow(-y, 0.5);
      colours.push(v, v * 1.01, v * 1.04);
    }
    sky.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    env.add(new THREE.Mesh(sky, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    const softbox = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 2.6, 2.6), side: THREE.DoubleSide })
    );
    softbox.position.set(0, 12, 4);
    softbox.rotation.x = Math.PI / 2;
    env.add(softbox);
    const tex = pmrem.fromScene(env, 0.035).texture;
    pmrem.dispose();
    sky.dispose();
    softbox.geometry.dispose();
    return tex;
  } catch (e) {
    return null; /* the paint is simply less shiny */
  }
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

/* The white panelled walls of a van body: one panel per repeat, a seam
   with a highlight on its edge, a little shading towards the floor. */
let panels = null;
function panelTexture(repeatU) {
  if (!panels) {
    const c = canvas2(256, 256);
    const g = c.getContext('2d');
    const across = g.createLinearGradient(0, 0, 256, 0);
    across.addColorStop(0, '#eceeee');
    across.addColorStop(0.5, '#f6f7f6');
    across.addColorStop(1, '#e9ebeb');
    g.fillStyle = across;
    g.fillRect(0, 0, 256, 256);
    const down = g.createLinearGradient(0, 0, 0, 256);
    down.addColorStop(0, 'rgba(0,0,0,0)');
    down.addColorStop(1, 'rgba(0,0,0,0.06)');
    g.fillStyle = down;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(60,64,68,0.38)';
    g.fillRect(0, 0, 3, 256);
    g.fillStyle = 'rgba(255,255,255,0.9)';
    g.fillRect(3, 0, 2, 256);
    panels = c;
  }
  const t = srgb(new THREE.CanvasTexture(panels));
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(Math.max(1, Math.round(repeatU)), 1);
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

/* Paint, glass and polished metal on the vehicle reflect a soft studio. The
   cargo boxes do not use it, so their colours stay as the list shows them. */
const paintMat = (colour) => mat(colour, { metalness: 0.55, roughness: 0.3, envMap: studio, envMapIntensity: 1 });
const glassMat = () => mat(0x141b22, { metalness: 0.3, roughness: 0.06, envMap: studio, envMapIntensity: 1.5 });
const trimMat = () => mat(0x2a2d31, { roughness: 0.7 });
const alloyMat = () => mat(0xa9aeb4, { metalness: 0.7, roughness: 0.25, envMap: studio, envMapIntensity: 1.2 });
const tireMat = () => mat(0x1b1d20, { roughness: 0.9, side: THREE.DoubleSide });
const rimMat = () => mat(0x4b5056, { metalness: 0.55, roughness: 0.35, envMap: studio, envMapIntensity: 0.9 });

/* A tyre with rounded shoulders, turned on its side (axis along z). */
function tyreGeometry(r, w) {
  const inner = r * 0.62;
  const sh = Math.min(0.07, w * 0.25);
  const pts = [
    [inner, -w / 2], [r - sh, -w / 2], [r - sh * 0.3, -w / 2 + sh * 0.3], [r, -w / 2 + sh],
    [r, w / 2 - sh], [r - sh * 0.3, w / 2 - sh * 0.3], [r - sh, w / 2], [inner, w / 2]
  ].map((p) => new THREE.Vector2(p[0], p[1]));
  const g = new THREE.LatheGeometry(pts, 40);
  g.rotateX(Math.PI / 2);
  return g;
}

function disc(radius, height, segments) {
  const g = new THREE.CylinderGeometry(radius, radius, height, segments || 28);
  g.rotateX(Math.PI / 2);
  return g;
}

/* A wheel (or a pair of twin wheels); out is +1 or -1, the side the hub and
   its nuts face. */
function wheel(group, x, zCentre, r, width, dual, out) {
  const tyre = tyreGeometry(r, width);
  const rim = disc(r * 0.63, width - 0.03);
  const tm = tireMat();
  const rm = rimMat();
  const offsets = dual ? [-width * 0.52, width * 0.52] : [0];
  offsets.forEach((o) => {
    const t = new THREE.Mesh(tyre, tm);
    t.position.set(x, r, zCentre + o);
    t.castShadow = true;
    t.receiveShadow = true;
    group.add(t);
    const m = new THREE.Mesh(rim, rm);
    m.position.copy(t.position);
    m.receiveShadow = true;
    group.add(m);
  });
  /* the outer face: hub cap and a ring of wheel nuts */
  const face = zCentre + out * ((dual ? width * 0.52 : 0) + width / 2 - 0.015);
  const hub = new THREE.Mesh(disc(r * 0.24, 0.07, 20), mat(0x3a3d41, { metalness: 0.5, roughness: 0.4 }));
  hub.position.set(x, r, face + out * 0.02);
  group.add(hub);
  const nutGeo = disc(0.02, 0.04, 6);
  const nutMat = alloyMat();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const n = new THREE.Mesh(nutGeo, nutMat);
    n.position.set(x + Math.cos(a) * r * 0.36, r + Math.sin(a) * r * 0.36, face + out * 0.01);
    group.add(n);
  }
}

/* An axle: wheels on both sides, at the track (bitola) apart. */
function axle(group, x, centreZ, track, r, dual) {
  const half = track / 2;
  const width = dual ? 0.27 : 0.32;
  wheel(group, x, centreZ + half, r, width, dual, 1);
  wheel(group, x, centreZ - half, r, width, dual, -1);
  box(group, 0.12, 0.12, track - 0.2, x, r, centreZ, mat(0x2f3337));
}

/* A mudguard over a wheel set: a curved fender following the tyre, from a
   little ahead of it over the top to a little behind. */
function mudguard(group, x, centreZ, track, r) {
  const width = 0.66;
  const s = new THREE.Shape();
  const inner = r + 0.07;
  const outer = r + 0.11;
  s.absarc(0, 0, outer, Math.PI * 0.08, Math.PI * 0.92, false);
  s.absarc(0, 0, inner, Math.PI * 0.92, Math.PI * 0.08, true);
  const geo = new THREE.ExtrudeGeometry(s, { depth: width, bevelEnabled: false, curveSegments: 28 });
  geo.translate(0, 0, -width / 2);
  const m = trimMat();
  [centreZ + track / 2, centreZ - track / 2].forEach((z) => {
    const f = new THREE.Mesh(geo, m);
    f.position.set(x, r, z);
    f.castShadow = true;
    f.receiveShadow = true;
    group.add(f);
  });
}

/* The two landing legs of a semitrailer, with their crank gearbox, the cross
   brace between them and the sand shoes on the ground. */
function landingGear(group, x, deck, cz, W, steel) {
  const legH = deck - 0.25;
  const zs = [cz + W * 0.36, cz - W * 0.36];
  zs.forEach((z) => {
    box(group, 0.14, legH * 0.55, 0.14, x, deck - 0.25 - legH * 0.275, z, steel); /* outer tube */
    box(group, 0.1, legH * 0.5, 0.1, x, legH * 0.25 + 0.06, z, steel); /* inner tube */
    box(group, 0.34, 0.05, 0.3, x, 0.03, z, steel); /* sand shoe */
  });
  box(group, 0.08, 0.08, W * 0.72, x, deck - 0.25 - legH * 0.45, cz, steel); /* cross brace */
  const side = zs[0];
  box(group, 0.2, 0.2, 0.16, x, deck - 0.4, side + 0.12, steel); /* gearbox */
  box(group, 0.03, 0.3, 0.03, x + 0.12, deck - 0.55, side + 0.22, trimMat()); /* crank handle */
}

/* The turntable and dolly frame over the front axles of a drawbar trailer. */
function turntable(group, xs, deck, cz, W, wheelR, steel) {
  const from = Math.min(...xs);
  const to = Math.max(...xs);
  const mid = (from + to) / 2;
  const ring = new THREE.Mesh(new THREE.CylinderGeometry(W * 0.32, W * 0.32, 0.08, 36), mat(0x23262a, { metalness: 0.4 }));
  ring.position.set(mid, deck - 0.36, cz);
  ring.castShadow = true;
  group.add(ring);
  box(group, to - from + 0.9, 0.14, W * 0.5, mid, wheelR + 0.16, cz, steel); /* dolly frame */
  [cz + W * 0.2, cz - W * 0.2].forEach((z) => {
    box(group, 0.12, deck - 0.4 - (wheelR + 0.16), 0.12, mid, (deck - 0.4 + wheelR + 0.16) / 2, z, steel);
  });
}

/* The frame of a closed van body: aluminium rails along the top and bottom
   edges and corner posts, like the body in the reference photo. */
function bodyFrame(group, L, W, H, deck, cz) {
  const alu = mat(0xc9ced3, { metalness: 0.6, roughness: 0.3, envMap: studio });
  const t = 0.07;
  [deck + H, deck + t / 2].forEach((y) => {
    [cz + W / 2, cz - W / 2].forEach((z) => box(group, L + t, t, t, L / 2, y, z, alu));
    [0, L].forEach((x) => box(group, t, t, W + t, x, y, cz, alu));
  });
  [0, L].forEach((x) => {
    [cz + W / 2, cz - W / 2].forEach((z) => box(group, t, H, t, x, deck + H / 2, z, alu));
  });
}

/* A cab-over cab in the style of a modern European truck: a high roof that
   rounds down to the sun visor, a raked windscreen, a dark grille with
   slats, headlights in the bumper, door and sleeper windows, mirrors on
   arms, side vents, steps and wheel arches cut around the steering wheels.

   o: { xFront, xRear, top, width, cz, colour, wheels: [x of the axles that
   may sit under the cab] }. The side profile is extruded across the width,
   so the arches go right through it. Returns { xRear, covered }: where the
   cab really ends (it stops short of a wheel it cannot cover) and which
   wheels sit in its arches. */
const ARCH_R = 0.62;

function cab(group, o) {
  const xFront = o.xFront;
  const top = o.top;
  const width = o.width;
  const cz = o.cz;
  let len = Math.max(1.6, o.xRear - xFront);
  const arches = [];
  const covered = [];
  (o.wheels || []).slice().sort((a, b) => a - b).forEach((wx) => {
    const ax = wx - xFront;
    if (ax - ARCH_R >= len) return; /* behind the cab */
    if (ax + ARCH_R > len - 0.1) {
      /* the arch would cut the rear corner: end the cab ahead of this wheel */
      const lastEnd = arches.length ? arches[arches.length - 1] + ARCH_R + 0.03 : 1.6;
      const shorter = ax - ARCH_R - 0.05;
      if (shorter >= Math.max(1.6, lastEnd)) {
        len = shorter;
        return;
      }
      len = ax + ARCH_R + 0.15;
    }
    arches.push(ax);
    covered.push(wx);
  });

  const b = 0.42; /* underside of the cab */
  const H = top - b;
  const at = (f) => b + H * f;
  /* the nose, from the bumper up to the windscreen top: [height, set-back] */
  const nose = [[b, 0.03], [at(0.12), -0.03], [at(0.3), 0], [at(0.46), 0.03], [at(0.8), 0.17]];
  const noseAt = (v) => {
    for (let i = 1; i < nose.length; i++) {
      if (v <= nose[i][0]) {
        const t = (v - nose[i - 1][0]) / (nose[i][0] - nose[i - 1][0]);
        return nose[i - 1][1] + t * (nose[i][1] - nose[i - 1][1]);
      }
    }
    return nose[nose.length - 1][1];
  };

  const s = new THREE.Shape();
  s.moveTo(nose[0][1], b);
  arches.forEach((ax) => {
    s.lineTo(ax - ARCH_R, b);
    s.lineTo(ax - ARCH_R, 0.5);
    s.absarc(ax, 0.5, ARCH_R, Math.PI, 0, true);
    s.lineTo(ax + ARCH_R, b);
  });
  s.lineTo(len, b);
  s.lineTo(len, top - 0.12);
  s.quadraticCurveTo(len, top, len - 0.12, top);
  s.lineTo(Math.min(0.95, len * 0.45), top);
  s.quadraticCurveTo(0.32, top, 0.22, at(0.87)); /* the roof cap rounds down */
  for (let i = nose.length - 1; i >= 1; i--) s.lineTo(nose[i][1], nose[i][0]);
  s.closePath();

  const bevel = 0.07;
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: width - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelOffset: -bevel,
    bevelSegments: 4,
    curveSegments: 18
  });
  const paint = paintMat(o.colour);
  const body = new THREE.Mesh(geo, paint);
  body.position.set(xFront, 0, cz - width / 2 + bevel);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const glass = glassMat();
  const trim = trimMat();
  const X = (u) => xFront + u;

  /* windscreen, set on the raked face, and the sun visor over it */
  const wsLow = at(0.47);
  const wsHigh = at(0.795);
  const rake = noseAt(wsHigh) - noseAt(wsLow);
  const ws = box(group, 0.02, Math.hypot(rake, wsHigh - wsLow) - 0.04, width * 0.84,
    X((noseAt(wsLow) + noseAt(wsHigh)) / 2 - 0.012), (wsLow + wsHigh) / 2, cz, glass, false);
  ws.rotation.z = -Math.atan2(rake, wsHigh - wsLow);
  box(group, 0.2, 0.07, width * 0.92, X(noseAt(wsHigh) - 0.03), at(0.82) + 0.01, cz, trim);

  /* grille with slats */
  const gLow = at(0.21);
  const gHigh = at(0.41);
  const gu = Math.min(noseAt(gLow), noseAt(gHigh)) - 0.012;
  box(group, 0.05, gHigh - gLow, width * 0.6, X(gu + 0.01), (gLow + gHigh) / 2, cz, trim, false);
  const slat = mat(0x9ca1a7, { metalness: 0.6, roughness: 0.3, envMap: studio });
  for (let i = 1; i <= 4; i++) {
    box(group, 0.03, 0.03, width * 0.58, X(gu - 0.012), gLow + ((gHigh - gLow) * i) / 5, cz, slat, false);
  }

  /* bumper wrapping round the front corners, headlights and fog lights */
  const bTop = at(0.12);
  box(group, 0.32, bTop - b, width + 0.02, X(0.1), (b + bTop) / 2, cz, mat(0x3b3f44, { roughness: 0.55 }));
  box(group, 0.02, (bTop - b) * 0.3, width * 0.5, X(-0.065), b + (bTop - b) * 0.45, cz, trim, false);
  const lamp = mat(0xfff8e6, { emissive: 0x77705e, roughness: 0.2, metalness: 0.2 });
  [1, -1].forEach((side) => {
    const z = cz + side * width * 0.33;
    box(group, 0.04, 0.21, 0.54, X(noseAt(at(0.165)) - 0.02), at(0.165), z, trim, false);
    box(group, 0.03, 0.15, 0.47, X(noseAt(at(0.165)) - 0.04), at(0.165), z, lamp, false);
    box(group, 0.02, 0.07, 0.14, X(-0.07), b + (bTop - b) * 0.45, cz + side * width * 0.38, lamp, false);
  });

  /* doors, windows, vents and steps on both sides */
  const doorEnd = Math.min(1.2, len * 0.52);
  const lastArch = arches.length ? arches[arches.length - 1] + ARCH_R : 0;
  const seamU = doorEnd + 0.05;
  let seamLow = at(0.1);
  arches.forEach((ax) => {
    const d = Math.abs(seamU - ax);
    if (d < ARCH_R) seamLow = Math.max(seamLow, 0.5 + Math.sqrt(ARCH_R * ARCH_R - d * d) + 0.05);
  });
  [1, -1].forEach((side) => {
    const face = cz + side * (width / 2 + 0.004);
    box(group, doorEnd - 0.34, at(0.76) - at(0.52), 0.012, X((0.3 + doorEnd) / 2 + 0.02), (at(0.52) + at(0.76)) / 2, face, glass, false);
    if (len > 2.0) {
      box(group, 0.3, at(0.74) - at(0.57), 0.012, X(doorEnd + 0.26), (at(0.57) + at(0.74)) / 2, face, glass, false);
    }
    /* door seam (stopping above a wheel arch) and handle */
    box(group, 0.015, at(0.79) - seamLow, 0.008, X(seamU), (seamLow + at(0.79)) / 2, face, trim, false);
    box(group, 0.14, 0.035, 0.025, X(doorEnd - 0.15), at(0.47), face + side * 0.01, trim, false);
    /* vertical air vent near the back of the cab */
    if (len > 1.9) {
      box(group, 0.11, at(0.66) - at(0.3), 0.014, X(len - 0.24), (at(0.3) + at(0.66)) / 2, face, trim, false);
      for (let i = 1; i < 8; i++) {
        box(group, 0.09, 0.012, 0.018, X(len - 0.24), at(0.3) + ((at(0.66) - at(0.3)) * i) / 8, face, slat, false);
      }
    }
    /* steps behind the front wheel */
    const stepFrom = lastArch + 0.06;
    const stepTo = len - 0.06;
    if (stepTo - stepFrom >= 0.22) {
      box(group, stepTo - stepFrom, at(0.2) - b, 0.02, X((stepFrom + stepTo) / 2), (b + at(0.2)) / 2, face, trim, false);
      [b + 0.12, b + (at(0.2) - b) * 0.6].forEach((y) => {
        box(group, stepTo - stepFrom - 0.06, 0.03, 0.1, X((stepFrom + stepTo) / 2), y, face - side * 0.04, slat, false);
      });
    }
    /* mirrors on arms: the main mirror and the wide-angle one under it */
    box(group, 0.04, 0.04, 0.3, X(0.36), at(0.8), cz + side * (width / 2 + 0.14), trim);
    box(group, 0.04, at(0.8) - at(0.48), 0.04, X(0.36), (at(0.8) + at(0.48)) / 2, cz + side * (width / 2 + 0.28), trim);
    box(group, 0.1, 0.5, 0.16, X(0.3), at(0.68), cz + side * (width / 2 + 0.3), paint);
    box(group, 0.09, 0.2, 0.14, X(0.3), at(0.5), cz + side * (width / 2 + 0.3), paint);
  });

  /* radio aerial on the roof */
  const aerial = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.012, 0.6, 6), trim);
  aerial.position.set(X(0.7), top + 0.27, cz - width * 0.36);
  aerial.rotation.z = 0.3;
  group.add(aerial);

  return { xRear: xFront + len, covered };
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

/* A tractor unit with its fifth wheel (where the kingpin rests) at x = kp,
   under a semitrailer whose deck is at height deck. Returns the x of the
   front of its cab. */
function tractorUnit(world, tr, kp, deck, cz) {
  const steel = mat(0x2c3035, { roughness: 0.6, metalness: 0.3 });
  const wheelR = 0.5;
  const trRoles = S().roles(tr.type);
  const ttrack = (tr.track > 0 ? tr.track : 2050) * MM;
  const tx = tr.axles.map((a) => kp + a.dist * MM);
  const xFront = tx[0] - 1.3;
  const chassisTop = deck - 0.16;
  const fronts = tx.filter((x, i) => trRoles[i] && trRoles[i].role === 'front');
  const c = cab(world, {
    xFront,
    /* the cab ends ahead of the semitrailer; with impossible axle values it
       keeps its own length rather than turning inside out */
    xRear: Math.max(xFront + 1.8, Math.min(xFront + 2.35, kp - 0.9, -0.15)),
    top: 3.7,
    width: 2.48,
    cz,
    colour: CAB_COLOUR,
    wheels: fronts
  });
  /* frame rails from under the cab to behind the last axle */
  const frameEnd = tx[tx.length - 1] + 0.75;
  [cz + 0.42, cz - 0.42].forEach((z) => {
    box(world, frameEnd - xFront - 0.4, 0.28, 0.1, (xFront + 0.4 + frameEnd) / 2, chassisTop - 0.24, z, steel);
  });
  /* fifth wheel */
  const fifth = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 28), mat(0x23262a, { metalness: 0.4 }));
  fifth.position.set(kp, chassisTop - 0.05, cz);
  fifth.castShadow = true;
  world.add(fifth);
  let firstRear = Infinity;
  tr.axles.forEach((a, i) => {
    const front = trRoles[i] && trRoles[i].role === 'front';
    axle(world, tx[i], cz, ttrack, wheelR, !front);
    if (c.covered.indexOf(tx[i]) < 0) mudguard(world, tx[i], cz, ttrack, wheelR);
    if (!front) firstRear = Math.min(firstRear, tx[i]);
  });
  /* fuel tank and air tanks between the cab and the drive axle
     (behind a second steering axle the cab does not cover) */
  let tankFrom = c.xRear + 0.12;
  fronts.forEach((x) => {
    if (c.covered.indexOf(x) < 0) tankFrom = Math.max(tankFrom, x + 0.7);
  });
  const tankLen = Math.min(1.5, firstRear - 0.75 - tankFrom);
  if (tankLen >= 0.45) {
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.29, 0.29, tankLen, 28), alloyMat());
    tank.rotation.z = Math.PI / 2;
    tank.position.set(tankFrom + tankLen / 2, 0.78, cz + 0.98);
    tank.castShadow = true;
    world.add(tank);
    [0.15, tankLen - 0.15].forEach((d) => {
      const strap = new THREE.Mesh(new THREE.TorusGeometry(0.295, 0.012, 6, 28), trimMat());
      strap.rotation.y = Math.PI / 2;
      strap.position.set(tankFrom + d, 0.78, cz + 0.98);
      world.add(strap);
    });
    const air = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, tankLen * 0.8, 20), mat(0x3a3e43, { roughness: 0.5 }));
    air.rotation.z = Math.PI / 2;
    air.position.set(tankFrom + tankLen / 2, 0.82, cz - 0.95);
    world.add(air);
  }
  return xFront;
}

/* The cargo space and its vehicle, without the cargo: floor, walls, chassis,
   wheels, cab, and the tractor for a semitrailer. A tractor unit on its own
   (in the form that creates one) is drawn with its fifth wheel at x = 0.
   Returns what the cargo and the camera need. */
function buildVehicle(world, sp, tr, opts) {
  /* closed: the outside of the body with its frame (the form's side view);
     otherwise the walls are cut open towards the viewer to show the cargo */
  const closed = !!(opts && opts.closed);
  const t0 = S().typeOf(sp.type);
  if (t0 && t0.kind === 'tractor') {
    const deck = deckHeight('semi', 'semi3');
    const front = tractorUnit(world, sp, 0, deck, -1.24);
    return { deck, W: 2.48, H: 0, kind: 'tractor', tractor: null, minX: front - 0.1, maxX: 0 };
  }
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

  /* walls: open towards the viewer (inner faces only, no roof), or closed */
  if (!flat) {
    /* a container has corrugated steel walls; a van body white panels */
    const wall = (span) => mat(0xffffff, {
      map: kind === 'box' ? wallTexture(span / 0.3, 1) : panelTexture(span / 1.15),
      side: closed ? THREE.FrontSide : THREE.BackSide
    });
    const wallMats = [
      wall(W), /* +x rear doors */
      wall(W), /* -x front wall */
      closed ? mat(0xe4e7ea) : new THREE.MeshBasicMaterial({ visible: false }), /* roof */
      new THREE.MeshBasicMaterial({ visible: false }), /* floor drawn above */
      wall(L),
      wall(L)
    ];
    const walls = new THREE.Mesh(new THREE.BoxGeometry(L, H, W), wallMats);
    walls.position.set(L / 2, deck + H / 2, cz);
    walls.castShadow = closed;
    walls.receiveShadow = true;
    world.add(walls);
    if (closed && kind !== 'box') bodyFrame(world, L, W, H, deck, cz);
  }
  /* frame of the cargo space */
  if (!closed || flat) {
    const frame = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(L, H, W)),
      new THREE.LineBasicMaterial({ color: 0x5c5b5b, transparent: true, opacity: flat ? 0.35 : 0.8 })
    );
    frame.position.set(L / 2, deck + H / 2, cz);
    world.add(frame);
  }
  if (flat) {
    /* stakes along the sides of a platform */
    const stake = mat(0x4b5056);
    for (let x = 0.4; x < L; x += 1.2) {
      [0, -W].forEach((z) => box(world, 0.06, 0.5, 0.06, x, deck + 0.25, z, stake));
    }
  }

  /* chassis and running gear */
  const steel = mat(0x2c3035, { roughness: 0.6, metalness: 0.3 });
  const cabColour = CAB_COLOUR;
  const guardMat = mat(0x8f949a, { metalness: 0.45, roughness: 0.4, envMap: studio });
  let minX = 0;
  let maxX = L;
  if (kind !== 'box') {
    /* the frame rails reach every wheel, even one typed outside the body,
       so nothing floats while the form is being filled in */
    const wheelXs = axles.filter((a, i) => !(roles[i] && roles[i].role === 'kingpin')).map((a) => a.dist * MM);
    const rails = [cz + W * 0.22, cz - W * 0.22];
    let railFront = 0.2;
    if (kind === 'lorry') railFront = Math.min(0, (axles[0] ? axles[0].dist * MM : -1.4) - 1.0);
    if (wheelXs.length) railFront = Math.min(railFront, Math.min(...wheelXs) - 0.75);
    const railEnd = Math.max(L - 0.1, wheelXs.length ? Math.max(...wheelXs) + 0.75 : 0);
    const railLen = railEnd - railFront;
    rails.forEach((z) => box(world, railLen, 0.24, 0.12, railFront + railLen / 2, deck - 0.2, z, steel));
    /* the grey bottom rail of the body, under the floor */
    box(world, L, 0.2, W + 0.02, L / 2, deck - 0.12, cz, mat(0x9aa0a6, { metalness: 0.35, roughness: 0.45, envMap: studio }));

    const running = []; /* wheels under the cargo space, for the side guards */
    const lorryFronts = [];
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
      if (kind === 'lorry' && front) lorryFronts.push(x);
      else {
        mudguard(world, x, cz, track, wheelR);
        running.push(x);
      }
    });

    let guardFrom = null; /* where the side guards start */
    if (kind === 'semi') {
      /* landing gear behind the kingpin */
      const lg = (axles[0] ? axles[0].dist * MM : 1.7) + 1.3;
      landingGear(world, lg, deck, cz, W, steel);
      guardFrom = lg + 0.15;
    }
    if (kind === 'trailer' && axles[0]) {
      const fronts = axles.filter((a, i) => roles[i] && roles[i].role === 'front').map((a) => a.dist * MM);
      turntable(world, fronts, deck, cz, W, wheelR, steel);
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
      const c = cab(world, {
        xFront,
        xRear: Math.max(xFront + 1.8, Math.min(-0.12, xFront + 2.3)),
        top: Math.max(2.6, Math.min(deck + H + 0.1, 3.85)),
        width: W * 0.98,
        cz,
        colour: cabColour,
        wheels: lorryFronts
      });
      /* a steering axle the cab does not cover (a bitruck's second) gets a mudguard */
      lorryFronts.forEach((x) => {
        if (c.covered.indexOf(x) < 0) {
          mudguard(world, x, cz, track, wheelR);
          running.push(x);
        }
      });
      guardFrom = Math.max(c.xRear, 0) + 0.15;
      minX = Math.min(minX, xFront - 0.1);
    }

    /* side underrun guards: two grey rails on brackets between the wheel sets */
    const marks = [];
    if (guardFrom !== null) marks.push({ x: guardFrom, after: 0, before: 0 });
    running.sort((a, b) => a - b).forEach((x) => marks.push({ x, after: 0.72, before: 0.72 }));
    for (let i = 1; i < marks.length; i++) {
      const a = marks[i - 1].x + marks[i - 1].after;
      const b = marks[i].x - marks[i].before;
      if (b - a < 1.0) continue;
      [1, -1].forEach((side) => {
        const z = cz + side * (W / 2 - 0.03);
        [0.5, 0.8].forEach((y) => box(world, b - a, 0.07, 0.04, (a + b) / 2, y, z, guardMat));
        const n = Math.max(2, Math.ceil((b - a) / 1.5) + 1);
        for (let k = 0; k < n; k++) {
          const x = a + 0.05 + ((b - a - 0.1) * k) / (n - 1);
          box(world, 0.05, deck - 0.22 - 0.46, 0.04, x, (deck - 0.22 + 0.46) / 2, z - side * 0.05, steel);
        }
      });
    }

    /* rear underrun bar and tail lights */
    box(world, 0.1, 0.13, W * 0.92, L - 0.08, 0.55, cz, guardMat);
    [1, -1].forEach((side) => {
      box(world, 0.06, deck - 0.22 - 0.55, 0.06, L - 0.12, (deck - 0.22 + 0.55) / 2, cz + side * W * 0.3, steel);
      box(world, 0.04, 0.1, 0.32, L + 0.01, deck - 0.3, cz + side * (W / 2 - 0.22),
        mat(0xc8302a, { emissive: 0x5a0e0b, roughness: 0.3 }), false);
    });
  }

  /* the tractor carrying a semitrailer */
  if (kind === 'semi' && tr && tr.axles && tr.axles.length >= 2) {
    const front = tractorUnit(world, tr, axles[0] ? axles[0].dist * MM : 1.7, deck, cz);
    minX = Math.min(minX, front - 0.1);
  }

  return { deck, W, H, kind, tractor: tr, minX, maxX };
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

  const v = buildVehicle(world, data.space, data.tractor);
  const deck = v.deck;
  const W = v.W;
  const H = v.H;
  const kind = v.kind;
  const tr = v.tractor;
  const minX = v.minX;
  const maxX = v.maxX;

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

/* ------------------------------------------------------------- side view --- */
/* The form that creates a cargo space draws its measurements over a side
   view of the very same vehicle: the model above, built without cargo,
   seen from the left side through an orthographic camera so that it is to
   scale. It has its own small renderer, so the planner's view is left
   alone. side() returns { url, minX, maxX, height, deck, pxPerMm, width,
   heightPx }: the picture (a PNG data URL) and where it sits in mm, with
   the ground at its bottom edge. */
let sideKit = null;

function sideRenderer() {
  if (sideKit) return sideKit;
  const canvas = document.createElement('canvas');
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.outputColorSpace = THREE.SRGBColorSpace;
  const sc = new THREE.Scene();
  sc.add(new THREE.HemisphereLight(0xffffff, 0x9aa1a8, 2.1));
  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(-12, 18, 30);
  sc.add(light);
  sideKit = { r, scene: sc, env: makeStudio(r), cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200) };
  return sideKit;
}

function side(space, maxW, maxH) {
  if (!renderer || !space) return null;
  let kit;
  try {
    kit = sideRenderer();
  } catch (e) {
    return null;
  }
  const group = new THREE.Group();
  const mainStudio = studio;
  studio = kit.env; /* the paint reflects the studio of this renderer */
  let v;
  try {
    v = buildVehicle(group, space, null, { closed: true });
  } finally {
    studio = mainStudio;
  }
  const bb = new THREE.Box3().setFromObject(group);
  const minX = bb.min.x - 0.05;
  const maxX = bb.max.x + 0.05;
  const top = bb.max.y + 0.05;
  const scale = Math.min(maxW / (maxX - minX), maxH / top); /* px per metre */
  const w = Math.max(1, Math.round((maxX - minX) * scale));
  const hPx = Math.max(1, Math.round(top * scale));
  const ratio = Math.min(2, window.devicePixelRatio || 1) * 1.5;
  kit.r.setPixelRatio(ratio);
  kit.r.setSize(w, hPx, false);
  const cam = kit.cam;
  cam.left = minX;
  cam.right = minX + w / scale;
  cam.top = top;
  cam.bottom = top - hPx / scale;
  cam.position.set(0, 0, 60);
  cam.lookAt(0, 0, 0);
  cam.updateProjectionMatrix();
  kit.scene.add(group);
  kit.r.render(kit.scene, cam);
  const url = kit.r.domElement.toDataURL('image/png');
  kit.scene.remove(group);
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const ms = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    ms.forEach((m) => {
      if (m.map && !isCached(m.map)) m.map.dispose();
      m.dispose();
    });
  });
  return {
    url,
    minX: minX / MM,
    maxX: (minX + w / scale) / MM,
    height: hPx / scale / MM,
    deck: v.deck / MM,
    pxPerMm: scale * MM,
    width: w,
    heightPx: hPx
  };
}

const api = { active: false, attach, update, render, side };
window.SyncrofinScene = api;

function boot() {
  const c = document.getElementById('view');
  if (!c || !window.SyncrofinApp || api.active) return;
  if (attach(c) && window.SyncrofinApp.redraw) window.SyncrofinApp.redraw();
}

/* Module scripts run before DOMContentLoaded; the planner starts on it. */
if (document.readyState === 'complete') boot();
else window.addEventListener('DOMContentLoaded', boot);
