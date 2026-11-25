import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { api } from './api.js';
import { game, RARITIES, rarityIndex, ACHIEVEMENTS, SKINS, xpToNext } from './game.js';
import { sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const CYAN = new THREE.Color(0x38e8ff);
const MAGENTA = new THREE.Color(0xff3df0);
const VIOLET = new THREE.Color(0x8a5cff);
const GOLD = new THREE.Color(0xffc857);
const RED = new THREE.Color(0xff4d6d);
const RARITY_COLORS = RARITIES.map((r) => new THREE.Color(r.color));

// ------------------------------------------------------------------ helpers
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (current, target, rate, dt) => lerp(current, target, 1 - Math.exp(-rate * dt));
const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

const TYPES = [
  [/^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/, 'IMAGE'],
  [/^(mp4|mkv|mov|avi|webm)$/, 'VIDEO'],
  [/^(mp3|wav|flac|ogg|m4a)$/, 'AUDIO'],
  [/^(js|ts|py|java|c|cpp|go|rs|sh|html|css|json|ya?ml|groovy|sql|xml)$/, 'CODE'],
  [/^(pdf|docx?|txt|md|pptx?|xlsx?|csv)$/, 'DOCUMENT'],
  [/^(zip|tar|gz|rar|7z|iso)$/, 'ARCHIVE'],
];
function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : 'file';
}
const fileType = (name) => (TYPES.find(([re]) => re.test(fileExt(name))) || [null, 'DATA'])[1];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ------------------------------------------------------------------ renderer + post fx
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x03040c);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 400);
const CAM_FAR = 34;
const CAM_DIST = 11.5;
const camDir = new THREE.Vector3(0, 0.3, 1).normalize();
camera.position.copy(camDir).multiplyScalar(CAM_FAR);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.minDistance = 6;
controls.maxDistance = 20;
controls.autoRotate = !reduceMotion;
controls.autoRotateSpeed = 0.45;
controls.enabled = false;

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.55, 0.28);
composer.addPass(bloom);
const rgbShift = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0 }, uGlitch: { value: 0 }, uTime: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uGlitch; uniform float uTime; varying vec2 vUv;
    float hash(float n) { return fract(sin(n) * 43758.5453); }
    void main() {
      vec2 uv = vUv;
      float slice = floor(uv.y * 36.0);
      float h = hash(slice * 12.9898 + floor(uTime * 24.0) * 7.31);
      if (h < uGlitch * 0.35) uv.x += (hash(slice + uTime) - 0.5) * 0.12 * uGlitch;
      vec2 off = (uv - 0.5) * (uAmount + uGlitch * 0.02);
      vec4 base = texture2D(tDiffuse, uv);
      float r = texture2D(tDiffuse, uv + off).r;
      float b = texture2D(tDiffuse, uv - off).b;
      gl_FragColor = vec4(r, base.g, b, base.a);
    }`,
});
composer.addPass(rgbShift);
composer.addPass(new OutputPass());

// Everything that swirls lives in this tilted group.
const world = new THREE.Group();
world.rotation.x = 0.2;
scene.add(world);

// ------------------------------------------------------------------ backdrop
function glowTexture(inner) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, inner);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

{
  const N = 2600;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(45 + Math.random() * 60);
    pos.set([v.x, v.y, v.z], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  scene.add(new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xbfe6ff, size: 0.22, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false,
  })));
  for (const [color, p, s] of [
    ['rgba(138,92,255,0.5)', [-38, 14, -60], 80],
    ['rgba(56,232,255,0.35)', [44, -10, -70], 90],
    ['rgba(255,61,240,0.3)', [6, 30, 75], 85],
  ]) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(color), blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.12,
    }));
    sprite.position.set(...p);
    sprite.scale.setScalar(s);
    scene.add(sprite);
  }
}

// Hex grid floor, like an arena.
{
  const grid = new THREE.Mesh(
    new THREE.CircleGeometry(16, 96),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uColor: { value: CYAN.clone() } },
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 uColor; varying vec2 vP;
        float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.732))), p.x); }
        void main() {
          vec2 p = vP * 1.1;
          vec2 r = vec2(1.0, 1.732); vec2 h = r * 0.5;
          vec2 a = mod(p, r) - h; vec2 b = mod(p - h, r) - h;
          vec2 g = dot(a, a) < dot(b, b) ? a : b;
          float edge = smoothstep(0.44, 0.5, hexDist(g));
          float d = length(vP);
          float wave = 0.5 + 0.5 * sin(d * 1.4 - uTime * 2.0);
          float fade = smoothstep(16.0, 4.0, d) * smoothstep(1.5, 4.0, d);
          gl_FragColor = vec4(uColor, edge * fade * (0.08 + wave * 0.12));
        }`,
    }),
  );
  grid.rotation.x = -Math.PI / 2;
  grid.position.y = -2.6;
  grid.userData.isGrid = true;
  world.add(grid);
  var gridMat = grid.material;
}

// ------------------------------------------------------------------ core
const coreUniforms = {
  uTime: { value: 0 }, uEnergy: { value: 0 }, uA: { value: VIOLET.clone() }, uB: { value: CYAN.clone() },
};
const core = new THREE.Mesh(
  new THREE.IcosahedronGeometry(1, 48),
  new THREE.ShaderMaterial({
    uniforms: coreUniforms,
    vertexShader: /* glsl */`
      uniform float uTime; uniform float uEnergy;
      varying vec3 vN; varying vec3 vV; varying float vD;
      void main() {
        vec3 p = position; float t = uTime;
        float n = sin(p.x * 3.1 + t * 1.3) * sin(p.y * 3.7 - t * 1.1) * sin(p.z * 4.3 + t * 0.9)
                + 0.5 * sin(p.x * 7.0 + t * 2.1) * sin(p.y * 6.0 + t * 1.7) * sin(p.z * 8.0 - t * 1.9);
        vD = n;
        p += normal * n * (0.10 + uEnergy * 0.18);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uA; uniform vec3 uB; uniform float uEnergy;
      varying vec3 vN; varying vec3 vV; varying float vD;
      void main() {
        float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 2.2);
        vec3 col = mix(uA, uB, clamp(vD * 0.9 + 0.5, 0.0, 1.0));
        col = col * (0.10 + f * 1.5) + vec3(1.0) * f * f * 0.3 * (1.0 + uEnergy);
        gl_FragColor = vec4(col, 1.0);
      }`,
  }),
);
world.add(core);

const cage = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.5, 1)),
  new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false }),
);
world.add(cage);

const rings = [
  [2.05, 0xff3df0, [1.2, 0.2, 0], [0.5, 0.3, 0]],
  [2.4, 0x38e8ff, [0.3, 0, 0.9], [-0.25, 0.45, 0.1]],
  [2.8, 0x8a5cff, [-0.8, 0.6, 0.2], [0.2, -0.35, 0.3]],
].map(([radius, color, rot, spin]) => {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.012, 8, 160),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.set(...rot);
  ring.userData.spin = spin;
  world.add(ring);
  return ring;
});

// ------------------------------------------------------------------ core skins (won from loot crates)
const PAL_KEYS = ['a', 'b', 'hot', 'inner', 'outer', 'r0', 'r1', 'r2'];
const pal = {};
const palTarget = {};
for (const k of PAL_KEYS) { pal[k] = new THREE.Color(); palTarget[k] = new THREE.Color(); }
const hexColor = (n) => `#${n.toString(16).padStart(6, '0')}`;

function skinSwatch(skin) {
  return skin.prism
    ? 'conic-gradient(#ff3d3d, #ffe03d, #3dff6a, #3de8ff, #6a5cff, #ff3df0, #ff3d3d)'
    : `linear-gradient(135deg, ${hexColor(skin.a)}, ${hexColor(skin.b)} 60%, ${hexColor(skin.hot)})`;
}

function applySkin(instant = false) {
  const skin = SKINS[game.skin];
  for (const k of ['a', 'b', 'hot', 'inner', 'outer']) palTarget[k].set(skin[k]);
  skin.rings.forEach((c, i) => palTarget[`r${i}`].set(c));
  if (instant) for (const k of PAL_KEYS) pal[k].copy(palTarget[k]);
  renderSkins();
}

function updatePalette(dt, time) {
  if (SKINS[game.skin].prism) {
    const h = time * 0.05;
    const hsl = (k, off, sat, light) => palTarget[k].setHSL((h + off) % 1, sat, light);
    hsl('a', 0, 0.9, 0.35); hsl('b', 0.15, 1, 0.6); hsl('hot', 0.5, 1, 0.65);
    hsl('inner', 0.33, 1, 0.6); hsl('outer', 0.66, 1, 0.55);
    hsl('r0', 0, 1, 0.6); hsl('r1', 0.33, 1, 0.6); hsl('r2', 0.66, 1, 0.6);
  }
  const t = 1 - Math.exp(-2.5 * dt);
  for (const k of PAL_KEYS) pal[k].lerp(palTarget[k], t);
}

function cycleSkin() {
  if (game.skins.length < 2) {
    sfx.error();
    feed({ icon: '◇', tag: 'SKINS', name: 'Only one skin owned — open loot crates to win more', kind: 'sys' });
    return;
  }
  const id = game.nextSkin();
  applySkin();
  sfx.ui();
  feed({ icon: '◇', tag: 'SKIN', name: SKINS[id].name, rarity: RARITIES[SKINS[id].rarity].key });
}

// Shield bubble, raised when files survive a pod wipe.
const shieldMat = new THREE.ShaderMaterial({
  uniforms: { uColor: { value: CYAN.clone() }, uOpacity: { value: 0 } },
  transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    varying vec3 vN; varying vec3 vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: /* glsl */`
    uniform vec3 uColor; uniform float uOpacity; varying vec3 vN; varying vec3 vV;
    void main() {
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.5);
      gl_FragColor = vec4(uColor * (0.3 + f * 1.6), (0.04 + f * 0.9) * uOpacity);
    }`,
});
const shield = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 4), shieldMat);
const shieldWire = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.002, 2)),
  new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
);
shield.add(shieldWire);
shield.visible = false;
world.add(shield);
let shieldT = 1;
function raiseShield() { shieldT = 0; shield.visible = true; }
function updateShield(dt) {
  if (!shield.visible) return;
  shieldT = Math.min(1, shieldT + dt / 3.2);
  const o = shieldT < 0.12 ? shieldT / 0.12 : 1 - (shieldT - 0.12) / 0.88;
  shield.scale.setScalar(2 + easeOutCubic(Math.min(shieldT * 4, 1)) * 7.5);
  shield.rotation.y += dt * 0.4;
  shieldMat.uniforms.uOpacity.value = o;
  shieldWire.material.opacity = o * 0.5;
  if (shieldT >= 1) shield.visible = false;
}

// Upload progress: an arc around the core that always faces the camera.
const progressUniforms = { uProgress: { value: 0 }, uOpacity: { value: 0 }, uA: { value: CYAN }, uB: { value: MAGENTA } };
const progressRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.82, 0.04, 8, 200),
  new THREE.ShaderMaterial({
    uniforms: progressUniforms, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: /* glsl */`
      uniform float uProgress; uniform float uOpacity; uniform vec3 uA; uniform vec3 uB; varying vec2 vUv;
      void main() {
        float on = step(vUv.x, uProgress);
        gl_FragColor = vec4(mix(uA, uB, vUv.x) * mix(0.12, 1.6, on), uOpacity);
      }`,
  }),
);
progressRing.renderOrder = 5;
scene.add(progressRing);

// ------------------------------------------------------------------ vortex
const vortexUniforms = {
  uFlow: { value: 0 }, uSpin: { value: 0 }, uEnergy: { value: 0 },
  uPR: { value: renderer.getPixelRatio() },
  uInner: { value: MAGENTA.clone() }, uOuter: { value: CYAN.clone() },
};
{
  const N = innerWidth < 760 ? 6000 : 12000;
  const radius = new Float32Array(N), angle = new Float32Array(N), height = new Float32Array(N);
  const speed = new Float32Array(N), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    radius[i] = Math.random() * 8.5;
    angle[i] = (i % 3) * (Math.PI * 2 / 3) + (Math.random() + Math.random() + Math.random() - 1.5) * 0.9;
    height[i] = (Math.random() + Math.random() - 1) * 1.4;
    speed[i] = 0.6 + Math.random() * 0.8;
    size[i] = 0.6 + Math.pow(Math.random(), 3) * 2.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
  geo.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
  geo.setAttribute('aAngle', new THREE.BufferAttribute(angle, 1));
  geo.setAttribute('aHeight', new THREE.BufferAttribute(height, 1));
  geo.setAttribute('aSpeed', new THREE.BufferAttribute(speed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 12);
  world.add(new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: vortexUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      attribute float aRadius; attribute float aAngle; attribute float aHeight; attribute float aSpeed; attribute float aSize;
      uniform float uFlow; uniform float uSpin; uniform float uEnergy; uniform float uPR;
      varying float vMix; varying float vAlpha;
      void main() {
        float r = 1.5 + mod(aRadius - uFlow * aSpeed, 8.5);
        float ang = aAngle + uSpin * 0.5 + r * 0.55;
        vec3 p = vec3(cos(ang) * r, aHeight * (0.12 + r * 0.07), sin(ang) * r);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = min(aSize * uPR * (20.0 / -mv.z) * (1.0 + uEnergy * 0.3), 7.0 * uPR);
        vAlpha = smoothstep(1.5, 2.7, r) * (1.0 - smoothstep(8.2, 10.0, r));
        vMix = smoothstep(1.8, 8.0, r);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uInner; uniform vec3 uOuter; varying float vMix; varying float vAlpha;
      void main() {
        float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
        gl_FragColor = vec4(mix(uInner, uOuter, vMix), a * vAlpha * 0.5);
      }`,
  })));
}

// ------------------------------------------------------------------ sparks (CPU particle pool)
const SPARKS = 3000;
const sparkPos = new Float32Array(SPARKS * 3);
const sparkVel = new Float32Array(SPARKS * 3);
const sparkCol = new Float32Array(SPARKS * 3);
const sparkLife = new Float32Array(SPARKS);
const sparkDecay = new Float32Array(SPARKS);
let sparkCursor = 0;
const sparkGeo = new THREE.BufferGeometry();
sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
sparkGeo.setAttribute('aColor', new THREE.BufferAttribute(sparkCol, 3));
sparkGeo.setAttribute('aLife', new THREE.BufferAttribute(sparkLife, 1));
sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 60);
world.add(new THREE.Points(sparkGeo, new THREE.ShaderMaterial({
  uniforms: { uPR: vortexUniforms.uPR }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec3 aColor; attribute float aLife; uniform float uPR; varying vec3 vC; varying float vL;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = min(aLife * uPR * (48.0 / -mv.z), 12.0 * uPR);
      vC = aColor; vL = aLife;
    }`,
  fragmentShader: /* glsl */`
    varying vec3 vC; varying float vL;
    void main() {
      float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
      gl_FragColor = vec4(vC, a * vL * 0.8);
    }`,
})));

const _v = new THREE.Vector3();
function spark(pos, vel, color, life = 1, decay = 1) {
  const i = sparkCursor;
  sparkCursor = (sparkCursor + 1) % SPARKS;
  sparkPos.set([pos.x, pos.y, pos.z], i * 3);
  sparkVel.set([vel.x, vel.y, vel.z], i * 3);
  sparkCol.set([color.r, color.g, color.b], i * 3);
  sparkLife[i] = life;
  sparkDecay[i] = decay;
}
function burst(pos, count, power, colorA, colorB = colorA) {
  for (let i = 0; i < count; i++) {
    _v.randomDirection().multiplyScalar(power * (0.25 + Math.random()));
    spark(pos, _v, Math.random() < 0.5 ? colorA : colorB, 1, 0.5 + Math.random() * 0.9);
  }
}
// A flat ring of sparks, used for level ups.
function nova(color, count = 260, power = 9) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    _v.set(Math.cos(a), (Math.random() - 0.5) * 0.15, Math.sin(a)).multiplyScalar(power * (0.85 + Math.random() * 0.3));
    spark(ORIGIN, _v, color, 1, 0.45 + Math.random() * 0.3);
  }
}
function updateSparks(dt) {
  const drag = 1 - 1.2 * dt;
  for (let i = 0; i < SPARKS; i++) {
    if (sparkLife[i] <= 0) continue;
    sparkLife[i] = Math.max(0, sparkLife[i] - sparkDecay[i] * dt);
    const k = i * 3;
    sparkPos[k] += sparkVel[k] * dt;
    sparkPos[k + 1] += sparkVel[k + 1] * dt;
    sparkPos[k + 2] += sparkVel[k + 2] * dt;
    sparkVel[k] *= drag; sparkVel[k + 1] *= drag; sparkVel[k + 2] *= drag;
  }
  sparkGeo.attributes.position.needsUpdate = true;
  sparkGeo.attributes.aLife.needsUpdate = true;
  sparkGeo.attributes.aColor.needsUpdate = true;
}

// ------------------------------------------------------------------ shockwaves
const shocks = Array.from({ length: 6 }, () => {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.94, 1, 128),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  mesh.visible = false;
  mesh.userData.t = 1;
  scene.add(mesh);
  return mesh;
});
function shockwave(color, delay = 0) {
  const s = shocks.find((m) => !m.visible) || shocks[0];
  s.material.color.copy(color);
  s.userData.t = -delay;
  s.visible = true;
}

// ------------------------------------------------------------------ juice: shake, flash, glitch
const fx = { shake: 0, aberration: 0, glitch: 0 };
function impact({ shake = 0.2, aberration = 0.01, glitch = 0, flash = null }) {
  if (reduceMotion) shake = 0;
  fx.shake = Math.max(fx.shake, shake);
  fx.aberration = Math.max(fx.aberration, aberration);
  fx.glitch = Math.max(fx.glitch, glitch);
  if (flash) {
    const f = $('flash');
    f.style.setProperty('--fc', flash);
    f.classList.remove('go');
    void f.offsetWidth;
    f.classList.add('go');
  }
}

// ------------------------------------------------------------------ item cards
const cardGeo = new THREE.PlaneGeometry(1.6, 1.0);

function cardTexture(name, size, footer) {
  const rarity = RARITIES[rarityIndex(size)];
  const W = 512, H = 320;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');

  g.beginPath();
  g.moveTo(30, 8); g.lineTo(W - 8, 8); g.lineTo(W - 8, H - 30); g.lineTo(W - 30, H - 8); g.lineTo(8, H - 8); g.lineTo(8, 30);
  g.closePath();
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, 'rgba(4, 8, 22, 0.95)');
  bg.addColorStop(1, `${rarity.color}33`);
  g.fillStyle = bg;
  g.fill();
  g.lineWidth = 6;
  g.strokeStyle = rarity.color;
  g.shadowColor = rarity.color;
  g.shadowBlur = 22;
  g.stroke();
  g.shadowBlur = 0;

  g.fillStyle = rarity.color;
  g.fillRect(8, 30, 10, H - 60);

  g.textBaseline = 'alphabetic';
  g.font = '900 72px Orbitron, sans-serif';
  g.fillText(fileExt(name).slice(0, 5).toUpperCase(), 40, 108);

  g.font = '700 26px Orbitron, sans-serif';
  g.textAlign = 'right';
  g.fillText(rarity.label, W - 34, 58);
  g.font = '24px "Share Tech Mono", monospace';
  g.fillStyle = '#ffc857';
  g.fillText(`+${rarity.xp} XP`, W - 34, 96);
  g.textAlign = 'left';

  g.font = '600 38px Rajdhani, sans-serif';
  g.fillStyle = '#eafaff';
  let label = name;
  while (g.measureText(label).width > W - 76 && label.length > 4) label = `${label.slice(0, -2).trimEnd()}…`;
  g.fillText(label, 40, 186);

  g.font = '26px "Share Tech Mono", monospace';
  g.fillStyle = '#8fb4c8';
  g.fillText(`${fileType(name)} · ${formatBytes(size)}`, 40, 234);
  g.fillStyle = rarity.color;
  g.fillText(footer, 40, 280);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function cardMesh(name, size, footer) {
  const mesh = new THREE.Mesh(cardGeo, new THREE.MeshBasicMaterial({
    map: cardTexture(name, size, footer), transparent: true, side: THREE.DoubleSide, depthWrite: false,
  }));
  mesh.renderOrder = 3;
  return mesh;
}
function disposeCard(mesh) {
  mesh.removeFromParent();
  mesh.material.map.dispose();
  mesh.material.dispose();
}

const cards = new Map(); // name -> card
let slotCounter = 0;

function addCard(file) {
  const i = slotCounter++;
  const idx = rarityIndex(file.size);
  const mesh = cardMesh(file.name, file.size, '▼ CLICK TO LOOT');
  mesh.scale.setScalar(0.001);
  mesh.userData.name = file.name;
  world.add(mesh);
  const card = {
    name: file.name, size: file.size, mesh, rarity: idx, color: RARITY_COLORS[idx],
    radius: 3.5 + (i % 4) * 0.95,
    angle: i * 2.399963,
    y: (((i * 0.618034) % 1) - 0.5) * 2.6,
    speed: 0.1 + ((i * 0.37) % 1) * 0.08,
    phase: i * 1.7,
    pos: new THREE.Vector3(),
    scale: 0.001,
    hover: false,
  };
  cards.set(file.name, card);
  return card;
}

function updateCards(dt, time) {
  for (const card of cards.values()) {
    let rate = 2.2;
    if (card.grabbed) {
      _v.copy(card.parked ? card.parkPos : grabPoint);
      rate = 14;
    } else {
      const a = card.angle + time * card.speed;
      _v.set(Math.cos(a) * card.radius, card.y + Math.sin(time * 0.8 + card.phase) * 0.2, Math.sin(a) * card.radius);
    }
    card.pos.x = damp(card.pos.x, _v.x, rate, dt);
    card.pos.y = damp(card.pos.y, _v.y, rate, dt);
    card.pos.z = damp(card.pos.z, _v.z, rate, dt);
    const doomed = card.grabbed && (card.parked || grab?.over);
    card.scale = damp(card.scale, doomed ? 0.85 : card.grabbed ? 1.2 : card.hover ? 1.35 : 1, 7, dt);
    card.mesh.position.copy(card.pos);
    if (doomed) card.mesh.position.x += (Math.random() - 0.5) * 0.05;
    card.mesh.scale.setScalar(card.scale);
    card.mesh.lookAt(camera.position);
    // Epic and legendary loot glitters.
    if (card.rarity >= 3 && Math.random() < (card.rarity === 4 ? 0.5 : 0.18)) {
      _v.set((Math.random() - 0.5) * 1.6, (Math.random() - 0.5) * 1.0, 0).applyQuaternion(card.mesh.quaternion).add(card.pos);
      spark(_v, _v.clone().set(0, 0.4, 0), card.color, 0.7, 1.2);
    }
  }
}

const beamGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
const beam = new THREE.Line(beamGeo, new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
beam.visible = false;
beam.frustumCulled = false;
world.add(beam);

// ------------------------------------------------------------------ HUD: player, stats, feed, pops
function updatePlayer(animate = false) {
  $('lvl').textContent = game.level;
  $('rank').textContent = game.rank;
  const need = xpToNext(game.level);
  const pct = `${Math.min(100, (game.xp / need) * 100)}%`;
  $('xpghost').style.width = pct;
  $('xpfill').style.width = pct;
  $('xptext').textContent = `${game.xp} / ${need} XP`;
  $('stat-uploads').textContent = game.uploads;
  $('stat-combo').textContent = `x${game.bestCombo}`;
  if (animate) {
    const p = document.querySelector('.player');
    p.classList.remove('up');
    void p.offsetWidth;
    p.classList.add('up');
  }
  renderProfile();
}

// ------------------------------------------------------------------ menu: profile, skins, achievements
function renderProfile() {
  if (!api.user) return;
  $('p-level').textContent = game.level;
  $('p-name').textContent = api.user.username;
  $('p-rank').textContent = game.rank;
  const stats = [
    ['UPLOADS', game.uploads], ['BEST COMBO', `x${game.bestCombo}`], ['PACKETS', game.packets],
    ['CRATES', game.cratesOpened], ['DOWNLOADS', game.retrieved], ['DESTROYED', game.destroyed],
  ];
  $('p-stats').replaceChildren(...stats.map(([k, v]) => {
    const d = el('div');
    d.append(el('b', null, String(v)), el('span', null, k));
    return d;
  }));
  const ids = Object.keys(ACHIEVEMENTS);
  $('p-ach-count').textContent = `${game.unlocked.length} / ${ids.length}`;
  $('achievements').replaceChildren(...ids.map((id) => {
    const a = ACHIEVEMENTS[id];
    const got = game.unlocked.includes(id);
    const li = el('li', got ? 'got' : '');
    const text = el('div');
    text.append(el('b', null, a.title), el('span', null, a.desc));
    li.append(el('i', null, got ? '★' : '?'), text);
    return li;
  }));
  renderSkins();
}

function renderSkins() {
  $('skins').replaceChildren(...Object.entries(SKINS).map(([id, skin]) => {
    const owned = game.skins.includes(id);
    const rarity = RARITIES[skin.rarity];
    const b = el('button', `skin-tile r-${rarity.key}${owned ? '' : ' locked'}${game.skin === id ? ' on' : ''}`);
    b.type = 'button';
    const dot = el('i');
    if (owned) dot.style.background = skinSwatch(skin);
    b.append(dot, el('span', null, owned ? skin.name : '???'));
    b.title = owned ? `${skin.name} · ${rarity.label}` : `Locked ${rarity.label} skin — win it from a loot crate`;
    if (owned) b.addEventListener('click', () => { if (game.equip(id)) { applySkin(); sfx.ui(); } });
    else b.disabled = true;
    return b;
  }));
}

const feedEl = $('feed');
function feed({ icon = '▸', tag = '', name = '', xp = '', rarity = null, kind = '' }) {
  const li = el('li', [kind, rarity ? `r-${rarity}` : ''].filter(Boolean).join(' '));
  li.append(el('span', 'ic', icon));
  if (tag) li.append(el('span', 'tag', tag));
  li.append(el('span', 'nm', name));
  if (xp) li.append(el('span', 'xp', xp));
  feedEl.prepend(li);
  while (feedEl.children.length > 6) feedEl.lastElementChild.remove();
  setTimeout(() => { li.classList.add('out'); setTimeout(() => li.remove(), 500); }, 6500);
}

function pop(big, small, rarityKey, x = innerWidth / 2, y = innerHeight / 2) {
  const p = el('div', `pop r-${rarityKey}`);
  p.style.left = `${x + (Math.random() - 0.5) * 120}px`;
  p.style.top = `${y + (Math.random() - 0.5) * 60}px`;
  if (small) p.append(el('span', 'sm', small));
  p.append(el('span', 'big', big));
  $('pops').append(p);
  setTimeout(() => p.remove(), 1700);
}

// Level-up banners and achievement cards play one at a time.
const showQueue = [];
let showing = false;
function showcase(item) {
  showQueue.push(item);
  if (!showing) nextShow();
}
function restart(node) {
  node.classList.remove('show');
  void node.offsetWidth;
  node.classList.add('show');
}
function showBanner(title, sub, variant = '') {
  const t = $('banner-title');
  t.textContent = title;
  t.dataset.text = title;
  $('banner-sub').textContent = sub;
  const b = $('banner');
  b.className = `banner ${variant}`;
  restart(b);
}
function nextShow() {
  const item = showQueue.shift();
  if (!item) { showing = false; return; }
  showing = true;
  if (item.run) {
    item.run();
    setTimeout(nextShow, item.duration || 2500);
    return;
  }
  if (item.type === 'level') {
    showBanner('LEVEL UP', `LEVEL ${item.level} · ${item.rank}`);
    sfx.levelUp();
    nova(GOLD);
    nova(MAGENTA, 160, 6);
    shockwave(GOLD);
    shockwave(MAGENTA, 0.15);
    impact({ shake: 0.35, aberration: 0.02, glitch: 1, flash: 'rgba(255,200,87,0.6)' });
    pulse = 1.2;
    updatePlayer(true);
  } else {
    const a = ACHIEVEMENTS[item.id];
    $('achv-title').textContent = a.title;
    $('achv-desc').textContent = a.desc;
    restart($('achv'));
    sfx.achievement();
    feed({ icon: '★', tag: 'ACHIEVEMENT', name: a.title, xp: '+50 XP', kind: 'sys' });
  }
  setTimeout(nextShow, 2500);
}

function award(result) {
  for (const id of result.unlocked) showcase({ type: 'achievement', id });
  if (result.levelUp) showcase({ type: 'level', level: result.levelUp, rank: game.rank });
  updatePlayer();
}

// ------------------------------------------------------------------ combo
const comboEl = $('combo');
function showCombo(n, mult) {
  if (n < 2) return;
  $('combo-n').textContent = n;
  $('combo-mult').textContent = `XP ×${mult.toFixed(1)}`;
  comboEl.classList.add('on');
  comboEl.classList.remove('bump');
  void comboEl.offsetWidth;
  comboEl.classList.add('bump');
  sfx.combo(n);
}

// ------------------------------------------------------------------ inventory
const slotsEl = $('slots');
let knownNames = null;

function renderInventory(files) {
  const fresh = knownNames ? files.filter((f) => !knownNames.has(f.name)).map((f) => f.name) : [];
  knownNames = new Set(files.map((f) => f.name));

  const slots = files.map((f) => {
    const r = RARITIES[rarityIndex(f.size)];
    const b = el('button', `slot r-${r.key}${fresh.includes(f.name) ? ' new' : ''}`);
    b.type = 'button';
    b.dataset.name = f.name;
    b.setAttribute('aria-label', `${f.name}, ${r.label}, ${formatBytes(f.size)}. Enter to download, Delete to destroy`);
    b.append(el('b', null, fileExt(f.name).slice(0, 4).toUpperCase()), el('small', null, formatBytes(f.size)));
    b.addEventListener('click', () => { if (!suppressClick) askDownload(f.name); });
    b.addEventListener('pointerdown', (e) => { if (e.button === 0) beginGrab(f.name, e); });
    b.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      e.preventDefault();
      const card = cards.get(f.name);
      if (card) askDestroy(card);
    });
    b.addEventListener('pointerenter', () => { sfx.hover(); hoverItem(f.name, true); });
    b.addEventListener('pointerleave', () => hoverItem(f.name, false));
    b.addEventListener('focus', () => hoverItem(f.name, true, b));
    b.addEventListener('blur', () => hoverItem(f.name, false));
    return b;
  });
  const cols = innerWidth <= 820 ? 7 : 5;
  const blanks = slots.length ? Math.max(cols * 3 - slots.length, (cols - (slots.length % cols)) % cols) : 0;
  for (let i = 0; i < blanks; i++) slots.push(el('div', 'slot blank'));
  slotsEl.replaceChildren(...slots);

  $('inv-count').textContent = `${files.length} ITEM${files.length === 1 ? '' : 'S'}`;
  $('inv-empty').hidden = files.length > 0;
  const badge = $('inv-badge');
  badge.textContent = files.length;
  if (fresh.length) { badge.classList.remove('ping'); void badge.offsetWidth; badge.classList.add('ping'); }
  $('stat-size').textContent = formatBytes(files.reduce((sum, f) => sum + f.size, 0));
  storedSizes = new Map(files.map((f) => [f.name, f.size]));
  updateStorage();
}

// ------------------------------------------------------------------ storage quota (per user)
let quotaBytes = null; // from /health; null until the server says
let storedSizes = new Map(); // name -> size of the files in the vault

function storedTotal() {
  let sum = 0;
  for (const size of storedSizes.values()) sum += size;
  return sum;
}

function updateStorage() {
  const box = $('storage');
  box.hidden = !quotaBytes;
  if (!quotaBytes) return;
  const used = storedTotal();
  const pct = Math.min(used / quotaBytes, 1);
  $('storage-text').textContent = `${formatBytes(used)} / ${formatBytes(quotaBytes)}`;
  $('storage-fill').style.width = `${(pct * 100).toFixed(1)}%`;
  box.classList.toggle('warn', pct >= 0.8 && pct < 0.98);
  box.classList.toggle('full', pct >= 0.98);
  box.title = `${formatBytes(Math.max(quotaBytes - used, 0))} free`;
}

// Stops an upload before it starts when it can't fit; the server checks again either way.
function fitsInQuota(file, queuedBytes = 0) {
  if (!quotaBytes) return true;
  const inFlight = uploads.reduce((sum, u) => sum + u.file.size, 0) + queuedBytes;
  const used = storedTotal() - (storedSizes.get(file.name) || 0) + inFlight;
  if (used + file.size <= quotaBytes) return true;
  feed({ icon: '✖', tag: 'STORAGE FULL',
    name: `${file.name} (${formatBytes(file.size)}) — only ${formatBytes(Math.max(quotaBytes - used, 0))} of ${formatBytes(quotaBytes)} left`, kind: 'bad' });
  sfx.error();
  return false;
}

const tooltip = $('tooltip');
const mouse = { x: innerWidth / 2, y: innerHeight / 2 };
addEventListener('pointermove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; placeTooltip(); });

function placeTooltip() {
  tooltip.style.left = `${mouse.x}px`;
  tooltip.style.top = `${mouse.y}px`;
  tooltip.classList.toggle('flip', mouse.x > innerWidth - 320);
}

function hoverItem(name, on, anchor = null) {
  const card = cards.get(name);
  if (card) card.hover = on;
  document.querySelectorAll('.slot.hot').forEach((s) => s.classList.remove('hot'));
  if (!on || !card) { tooltip.classList.remove('on'); return; }
  const r = RARITIES[card.rarity];
  tooltip.className = `tooltip on r-${r.key}`;
  tooltip.replaceChildren(
    el('div', 'tt-name', name),
    el('div', 'tt-rarity', `${r.label} ${fileType(name)}`),
    row('SIZE', formatBytes(card.size)),
    row('TYPE', fileExt(name).toUpperCase()),
    row('XP VALUE', `+${r.xp}`),
    el('div', 'tt-act', '[CLICK] DOWNLOAD… · [DRAG TO CORE] DESTROY'),
  );
  if (anchor) {
    const box = anchor.getBoundingClientRect();
    mouse.x = box.left - 10; mouse.y = box.top;
  }
  placeTooltip();
}
function row(k, v) {
  const d = el('div', 'tt-row');
  d.append(el('span', null, k), el('b', null, v));
  return d;
}

async function refresh() {
  let files;
  try {
    files = await api.list();
  } catch (err) {
    feed({ icon: '✖', name: `Could not load files: ${err.message}`, kind: 'bad' });
    return;
  }
  files.sort((a, b) => rarityIndex(b.size) - rarityIndex(a.size) || a.name.localeCompare(b.name));
  const names = new Set(files.map((f) => f.name));
  for (const [name, card] of cards) {
    if (!names.has(name)) { disposeCard(card.mesh); cards.delete(name); }
  }
  for (const f of files) {
    const card = cards.get(f.name);
    if (!card) addCard(f);
    else if (card.size !== f.size) {
      disposeCard(card.mesh);
      cards.delete(f.name);
      addCard(f);
    }
  }
  renderInventory(files);
  if (started) award(game.inventory(files.length));
}

// Downloads always go through a confirm popup, so a stray click never saves a file.
let pendingDownload = null;
function askDownload(name) {
  if (pendingDownload || pendingDestroy || !started) return;
  const card = cards.get(name);
  if (!card) return;
  pendingDownload = name;
  hoverItem(name, false); // hide the tooltip
  card.hover = true; // keep the card highlighted while the popup is open
  const r = RARITIES[card.rarity];
  const item = $('dl-item');
  item.className = `modal-item r-${r.key}`;
  item.replaceChildren(el('b', null, name), el('span', null, `${r.label} · ${fileType(name)} · ${formatBytes(card.size)}`));
  $('dl-confirm').hidden = false;
  $('dl-yes').focus();
  controls.enabled = false;
  sfx.ui();
}
function closeDownload(confirmed) {
  const name = pendingDownload;
  if (!name) return;
  pendingDownload = null;
  $('dl-confirm').hidden = true;
  controls.enabled = intro >= 1;
  const card = cards.get(name);
  if (card) card.hover = false;
  if (confirmed) retrieve(name);
  else sfx.ui();
}
$('dl-yes').addEventListener('click', () => closeDownload(true));
$('dl-no').addEventListener('click', () => closeDownload(false));
// Clicking the dark area around the popup cancels it.
$('dl-confirm').addEventListener('click', (e) => { if (e.target.id === 'dl-confirm') closeDownload(false); });

function retrieve(name) {
  const card = cards.get(name);
  sfx.retrieve();
  if (card) {
    burst(card.pos, 110, 3.4, card.color, CYAN);
    card.scale = 1.8;
    impact({ shake: 0.08, aberration: 0.008 });
  }
  api.download(name).catch((err) => feed({ icon: '✖', tag: 'FAILED', name: `${name} — ${err.message}`, kind: 'bad' }));
  feed({ icon: '▼', tag: 'LOOTED', name, rarity: card ? RARITIES[card.rarity].key : null });
  award(game.retrievedFile());
}

// ------------------------------------------------------------------ uploads
const uploads = [];
const uploadsEl = $('uploads');
const ORIGIN = new THREE.Vector3();

function ndcToWorldLocal(ndc, distance) {
  const p = new THREE.Vector3(ndc.x, ndc.y, 0.5).unproject(camera);
  p.sub(camera.position).normalize().multiplyScalar(distance).add(camera.position);
  return world.worldToLocal(p);
}

function startUpload(file, ndc) {
  const idx = rarityIndex(file.size);
  const r = RARITIES[idx];
  const mesh = cardMesh(file.name, file.size, '▲ TRANSMITTING');
  const start = ndcToWorldLocal(ndc, 7.5);
  mesh.position.copy(start);
  world.add(mesh);

  const li = el('li', `r-${r.key}`);
  const rowEl = el('div', 'row');
  rowEl.append(el('span', null, file.name), el('span', null, '0%'));
  const bar = el('div', 'bar');
  bar.append(el('i'));
  li.append(rowEl, bar);
  uploadsEl.append(li);

  const u = {
    file, mesh, li, idx, color: RARITY_COLORS[idx],
    r0: Math.max(Math.hypot(start.x, start.z), 2.5),
    a0: Math.atan2(start.z, start.x),
    y0: start.y,
    actual: 0, shown: 0, lastTick: 0, done: false, error: null,
  };
  uploads.push(u);
  burst(start, 50, 2.2, u.color, CYAN);
  sfx.launch();
  spawnPacket();
  if (Math.random() < 0.6) spawnPacket();
  feed({ icon: '▲', tag: r.label, name: file.name, rarity: r.key });
  api.upload(file, (p) => { u.actual = p; }).then(() => { u.done = true; }, (err) => { u.error = err; });
}

function launch(files, ndc) {
  if (!started) startGame();
  let queued = 0;
  let queuedBytes = 0; // files from this same drop that haven't started yet
  files.forEach((file) => {
    if (!fitsInQuota(file, queuedBytes)) return;
    queuedBytes += file.size;
    const i = queued++;
    const spread = {
      x: THREE.MathUtils.clamp(ndc.x + (i ? (Math.random() - 0.5) * 0.6 : 0), -0.9, 0.9),
      y: THREE.MathUtils.clamp(ndc.y + (i ? (Math.random() - 0.5) * 0.6 : 0), -0.9, 0.9),
    };
    setTimeout(() => startUpload(file, spread), i * 220);
  });
}

function onStored(u) {
  const result = game.stored(u.file.size, performance.now());
  const r = result.rarity;
  burst(ORIGIN, 260 + result.index * 90, 6 + result.index * 1.5, u.color, CYAN);
  shockwave(u.color);
  if (result.index >= 2) shockwave(MAGENTA, 0.12);
  impact({
    shake: 0.12 + result.index * 0.09,
    aberration: 0.006 + result.index * 0.006,
    glitch: result.index >= 3 ? 0.8 : 0,
    flash: result.index >= 3 ? r.color : null,
  });
  pulse = 1;
  sfx.store(result.index);

  pop(`+${result.gained} XP`, result.index >= 2 ? `${r.label}!` : null, r.key);
  feed({ icon: '◆', tag: r.label, name: u.file.name, xp: `+${result.gained} XP`, rarity: r.key });
  showCombo(result.combo, result.multiplier);
  if (result.crate) feed({ icon: '■', tag: 'CRATE', name: 'Loot crate earned!', kind: 'sys' });
  award(result);
  refresh();
}

function updateUploads(dt) {
  let total = 0;
  for (let i = uploads.length - 1; i >= 0; i--) {
    const u = uploads[i];
    u.shown = damp(u.shown, u.done ? 1 : u.actual * 0.96, 4.5, dt);
    total += u.shown;

    const tick = Math.floor(u.shown * 10);
    if (tick > u.lastTick) { u.lastTick = tick; sfx.tick(u.shown); }

    const e = Math.pow(u.shown, 1.4);
    const r = lerp(u.r0, 0.25, e);
    const a = u.a0 + e * Math.PI * 3.5;
    const pos = u.mesh.position.set(Math.cos(a) * r, lerp(u.y0, 0, e) + Math.sin(e * Math.PI) * 0.7, Math.sin(a) * r);
    u.mesh.scale.setScalar(lerp(1, 0.1, e));
    u.mesh.lookAt(camera.position);
    u.mesh.rotateZ(e * 9);

    for (let k = 0; k < 2 + u.idx; k++) {
      _v.randomDirection().multiplyScalar(0.5);
      spark(pos, _v, k % 2 ? u.color : CYAN, 0.8, 1.3);
    }

    const pct = Math.round(u.shown * 100);
    u.li.querySelector('i').style.width = `${pct}%`;
    u.li.querySelector('.row span:last-child').textContent = `${pct}%`;

    if (u.error) {
      burst(pos, 180, 5, RED);
      shockwave(RED);
      impact({ shake: 0.3, aberration: 0.02, glitch: 1, flash: 'rgba(255,77,109,0.5)' });
      sfx.error();
      feed({ icon: '✖', tag: 'FAILED', name: `${u.file.name} — ${u.error.message}`, kind: 'bad' });
    } else if (u.done && u.shown > 0.985) {
      onStored(u);
    } else continue;

    disposeCard(u.mesh);
    u.li.remove();
    uploads.splice(i, 1);
  }
  return uploads.length ? total / uploads.length : 0;
}

// ------------------------------------------------------------------ data packets (click them for XP)
const packets = [];
const packetGeo = new THREE.OctahedronGeometry(0.17, 0);
const packetHalo = glowTexture('rgba(255,200,87,0.9)');
let packetChain = 0;
let packetChainUntil = 0;
let packetTimer = 0;

function spawnPacket() {
  const mesh = new THREE.Mesh(packetGeo, new THREE.MeshBasicMaterial({
    color: GOLD, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: packetHalo, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.setScalar(0.9);
  mesh.add(halo);
  const dir = new THREE.Vector3().randomDirection();
  dir.y = Math.abs(dir.y) * 0.6 + 0.1;
  dir.normalize();
  mesh.position.copy(dir).multiplyScalar(1.4);
  world.add(mesh);
  packets.push({ mesh, vel: dir.multiplyScalar(1.3 + Math.random() * 0.9), life: 5 + Math.random(), age: 0 });
}

function removePacket(i) {
  const p = packets[i];
  p.mesh.removeFromParent();
  p.mesh.material.dispose();
  p.mesh.children[0].material.dispose();
  packets.splice(i, 1);
}

function updatePackets(dt, now) {
  if (uploads.length) {
    packetTimer -= dt;
    if (packetTimer <= 0) { spawnPacket(); packetTimer = 0.45 + Math.random() * 0.5; }
  }
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    p.age += dt;
    p.vel.multiplyScalar(1 - 0.35 * dt);
    p.mesh.position.addScaledVector(p.vel, dt);
    p.mesh.position.y += Math.sin(p.age * 3 + i) * 0.004;
    p.mesh.rotation.x += dt * 2.2;
    p.mesh.rotation.y += dt * 3.1;
    p.mesh.visible = p.life - p.age > 1.2 || Math.floor(p.age * 10) % 2 === 0; // blink before vanishing
    if (Math.random() < 0.3) spark(p.mesh.position, _v.set(0, 0, 0), GOLD, 0.5, 1.5);
    if (p.age >= p.life) removePacket(i);
  }
  if (packetChain && now > packetChainUntil) packetChain = 0;
}

const _wp = new THREE.Vector3();
function pickPacket() {
  raycaster.setFromCamera(pointer.ndc, camera);
  let best = -1;
  let bestDist = 0.7; // generous hit radius so moving packets are catchable
  packets.forEach((p, i) => {
    p.mesh.getWorldPosition(_wp);
    const d = raycaster.ray.distanceToPoint(_wp);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  return best;
}

function catchPacket(i, now) {
  const p = packets[i];
  p.mesh.getWorldPosition(_wp);
  packetChain = now < packetChainUntil ? packetChain + 1 : 1;
  packetChainUntil = now + 2500;
  const result = game.packet(packetChain);
  burst(p.mesh.position, 70, 2.6, GOLD, CYAN);
  sfx.catch(packetChain);
  impact({ shake: 0.05, aberration: 0.006 });
  const s = _wp.project(camera);
  pop(`+${result.value} XP`, packetChain > 1 ? `PACKET x${packetChain}` : 'PACKET', 'packet',
    ((s.x + 1) / 2) * innerWidth, ((1 - s.y) / 2) * innerHeight);
  removePacket(i);
  award(result);
}

// ------------------------------------------------------------------ loot crates
function crateTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#1a1206';
  g.fillRect(0, 0, 256, 256);
  g.globalAlpha = 0.22;
  g.fillStyle = '#ffc857';
  for (let i = -256; i < 256; i += 40) {
    g.beginPath(); g.moveTo(i, 256); g.lineTo(i + 20, 256); g.lineTo(i + 276, 0); g.lineTo(i + 256, 0); g.fill();
  }
  g.globalAlpha = 1;
  g.strokeStyle = '#ffc857';
  g.lineWidth = 14;
  g.strokeRect(7, 7, 242, 242);
  g.font = '900 150px Orbitron, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = '#ffc857';
  g.shadowBlur = 24;
  g.fillStyle = '#ffe9b0';
  g.fillText('?', 128, 138);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const crate = new THREE.Group();
const crateBox = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), new THREE.MeshBasicMaterial({ color: 0xffffff }));
const crateEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(crateBox.geometry),
  new THREE.LineBasicMaterial({ color: GOLD, transparent: true, blending: THREE.AdditiveBlending }),
);
crateEdges.scale.setScalar(1.03);
const crateGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: glowTexture('rgba(255,200,87,0.85)'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
}));
crateGlow.scale.setScalar(2.8);
crate.add(crateGlow, crateBox, crateEdges);
crate.visible = false;
scene.add(crate);

const crateState = { drop: 0, landed: false, opening: false, openT: 0, nextRattle: 0 };
const crateLabel = $('crate-label');
const _cp = new THREE.Vector3();
const easeOutBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const crateNdc = () => (innerWidth <= 820 ? { x: 0.5, y: 0.32 } : { x: 0, y: -0.45 });
function updateCrateCount() { $('crate-count').textContent = game.crates > 1 ? `x${game.crates}` : ''; }

function updateCrate(dt, time) {
  if (!crate.visible) {
    if (!started || intro < 1 || game.crates <= 0) return;
    if (!crateBox.material.map) { crateBox.material.map = crateTexture(); crateBox.material.needsUpdate = true; }
    Object.assign(crateState, { drop: 0, landed: false, opening: false, openT: 0, nextRattle: 0 });
    crate.scale.setScalar(1);
    crate.visible = true;
    updateCrateCount();
  }
  const ndc = crateNdc();
  crate.position.set(ndc.x, ndc.y, 0.5).unproject(camera).sub(camera.position).normalize().multiplyScalar(6).add(camera.position);
  crateState.drop = Math.min(1, crateState.drop + dt / 0.9);
  crate.position.y += (1 - easeOutBounce(crateState.drop)) * 3 + Math.sin(time * 2.2) * 0.06 * crateState.drop;
  if (crateState.drop === 1 && !crateState.landed) {
    crateState.landed = true;
    sfx.crateDrop();
    burst(world.worldToLocal(crate.position.clone()), 60, 2.5, GOLD);
    feed({ icon: '■', tag: 'CRATE', name: 'Loot crate dropped — click it to open', kind: 'sys' });
    crateLabel.hidden = false;
  }
  crateBox.rotation.y += dt * 0.9;
  crateBox.rotation.x = Math.sin(time * 1.3) * 0.2;
  crateEdges.rotation.copy(crateBox.rotation);
  crateGlow.material.opacity = 0.45 + Math.sin(time * 3) * 0.15;
  if (Math.random() < 0.25) {
    const p = world.worldToLocal(crate.position.clone()).add(_v.randomDirection().multiplyScalar(0.6));
    spark(p, _v.set(0, 0.6, 0), GOLD, 0.6, 1.3);
  }
  if (crateState.opening) {
    crateState.openT += dt;
    const k = Math.min(crateState.openT / 1.1, 1);
    crate.position.x += (Math.random() - 0.5) * 0.18 * k;
    crate.position.y += (Math.random() - 0.5) * 0.18 * k;
    crate.scale.setScalar(1 + k * 0.3);
    crateGlow.material.opacity = 0.6 + k * 0.6;
    if (crateState.openT >= crateState.nextRattle) { sfx.rattle(); crateState.nextRattle += 0.16 - k * 0.08; }
    if (k >= 1) finishCrate();
  }
  if (!crateLabel.hidden) {
    const s = _cp.copy(crate.position).project(camera);
    crateLabel.style.left = `${((s.x + 1) / 2) * innerWidth}px`;
    crateLabel.style.top = `${((1 - s.y) / 2) * innerHeight + 52}px`;
  }
}

function pickCrate() {
  if (!crate.visible || crateState.opening || !crateState.landed) return false;
  raycaster.setFromCamera(pointer.ndc, camera);
  return raycaster.intersectObject(crateBox, false).length > 0;
}

function openCrate() {
  if (!crate.visible || crateState.opening || !crateState.landed) return;
  crateState.opening = true;
  crateState.openT = 0;
  crateState.nextRattle = 0;
  crateLabel.hidden = true;
}
crateLabel.addEventListener('click', openCrate);

function finishCrate() {
  const at = world.worldToLocal(crate.position.clone());
  crate.visible = false;
  crateState.opening = false;
  const reward = game.openCrate();
  if (!reward) return;
  const r = RARITIES[reward.rarity];
  const color = RARITY_COLORS[reward.rarity];
  burst(at, 320, 7, color, GOLD);
  shockwave(color);
  impact({ shake: 0.25, aberration: 0.02, glitch: reward.rarity >= 3 ? 0.8 : 0.2, flash: r.color });
  sfx.crateOpen(reward.rarity);
  if (reward.kind === 'skin') applySkin();
  showReward(reward);
  updateCrateCount();
  award(reward);
}

function showReward(reward) {
  const r = RARITIES[reward.rarity];
  const box = $('reward');
  box.className = `reward r-${r.key}`;
  let name = 'XP CACHE';
  let desc = `+${reward.amount} XP`;
  if (reward.kind === 'skin') { name = reward.name; desc = 'New core skin — equipped. Change it in MENU → PROFILE.'; }
  else if (reward.duplicate) { name = reward.name; desc = `Duplicate skin → +${reward.amount} XP`; }
  $('reward-rarity').textContent = r.label;
  $('reward-name').textContent = name;
  $('reward-desc').textContent = desc;
  $('reward-orb').style.background = reward.id ? skinSwatch(SKINS[reward.id]) : `radial-gradient(circle, #fff3c4, ${r.color})`;
  restart(box);
  feed({ icon: '■', tag: 'CRATE', name: `${name} — ${desc}`, rarity: r.key });
}

// ------------------------------------------------------------------ drag an item into the core to destroy it
let grab = null; // { name, startX, startY, active, over, card }
let suppressClick = false;
let pendingDestroy = null;
let danger = 0;
const grabPoint = new THREE.Vector3();
const debris = [];

function beginGrab(name, e) {
  if (!started || pendingDestroy || pendingDownload) return;
  grab = { name, startX: e.clientX, startY: e.clientY, active: false, over: false, card: null };
}

function endGrab(cancelled) {
  const g = grab;
  grab = null;
  if (!pendingDestroy && started) controls.enabled = intro >= 1;
  if (!g || !g.active) return;
  document.body.classList.remove('grabbing');
  $('grab-hint').classList.remove('hot');
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 0);
  if (g.over && !cancelled) askDestroy(g.card);
  else { g.card.grabbed = false; sfx.ui(); }
}

addEventListener('pointermove', (e) => {
  if (!grab || grab.active) return;
  if (Math.hypot(e.clientX - grab.startX, e.clientY - grab.startY) < 10) return;
  const card = cards.get(grab.name);
  if (!card) { grab = null; return; }
  Object.assign(grab, { active: true, card });
  card.grabbed = true;
  card.parked = false;
  controls.enabled = false;
  hoverItem(grab.name, false);
  $('grab-hint').textContent = 'DRAG ONTO THE CORE TO DESTROY';
  document.body.classList.add('grabbing');
  sfx.grab();
});
addEventListener('pointerup', () => endGrab(false));
addEventListener('pointercancel', () => endGrab(true));

function coreScreen() {
  const c = _cp.set(0, 0, 0).project(camera);
  const x = ((c.x + 1) / 2) * innerWidth;
  const y = ((1 - c.y) / 2) * innerHeight;
  const edge = _v.set(1.9 * core.scale.x, 0, 0).applyQuaternion(camera.quaternion).project(camera);
  return { x, y, r: Math.max(50, Math.abs(((edge.x + 1) / 2) * innerWidth - x)) };
}

function updateGrab() {
  if (!grab?.active) return;
  const ndc = { x: (mouse.x / innerWidth) * 2 - 1, y: -(mouse.y / innerHeight) * 2 + 1 };
  grabPoint.copy(ndcToWorldLocal(ndc, camera.position.length() * 0.6));
  const cs = coreScreen();
  const over = Math.hypot(mouse.x - cs.x, mouse.y - cs.y) < cs.r;
  if (over !== grab.over) {
    grab.over = over;
    const hint = $('grab-hint');
    hint.textContent = over ? 'RELEASE TO DESTROY' : 'DRAG ONTO THE CORE TO DESTROY';
    hint.classList.toggle('hot', over);
    if (over) sfx.hover();
  }
  if (Math.random() < 0.5) spark(grab.card.pos, _v.randomDirection().multiplyScalar(0.8), over ? RED : grab.card.color, 0.6, 1.5);
}

function askDestroy(card) {
  if (pendingDestroy || !started) return;
  pendingDestroy = card;
  card.grabbed = true;
  card.parked = true;
  card.parkPos = ndcToWorldLocal({ x: 0, y: 0 }, camera.position.length() - 2.8);
  hoverItem(card.name, false);
  const r = RARITIES[card.rarity];
  const item = $('confirm-item');
  item.className = `modal-item r-${r.key}`;
  item.replaceChildren(el('b', null, card.name), el('span', null, `${r.label} · ${fileType(card.name)} · ${formatBytes(card.size)}`));
  $('confirm').hidden = false;
  $('confirm-no').focus();
  controls.enabled = false;
  sfx.grab();
}

async function closeConfirm(confirmed) {
  const card = pendingDestroy;
  if (!card) return;
  pendingDestroy = null;
  $('confirm').hidden = true;
  controls.enabled = intro >= 1;
  if (!confirmed) { card.grabbed = false; card.parked = false; sfx.ui(); return; }
  try {
    await api.remove(card.name);
  } catch (err) {
    card.grabbed = false;
    card.parked = false;
    sfx.error();
    feed({ icon: '✖', tag: 'FAILED', name: `Could not destroy ${card.name} — ${err.message}`, kind: 'bad' });
    return;
  }
  cards.delete(card.name);
  if (hovered === card) hovered = null;
  debris.push({ mesh: card.mesh, sink: true, from: card.pos.clone(), t: 0, color: card.color });
  feed({ icon: '✖', tag: 'DESTROYED', name: card.name, rarity: RARITIES[card.rarity].key });
  award(game.destroyedFile());
  refresh();
}
$('confirm-yes').addEventListener('click', () => closeConfirm(true));
$('confirm-no').addEventListener('click', () => closeConfirm(false));

function shatterCard(name) {
  const card = cards.get(name);
  if (!card) return;
  cards.delete(name);
  if (hovered === card) hovered = null;
  burst(card.pos, 140, 4.5, card.color, RED);
  debris.push({
    mesh: card.mesh, t: 0,
    vel: card.pos.clone().normalize().multiplyScalar(3 + Math.random() * 3).add(new THREE.Vector3(0, 2.5, 0)),
    spin: new THREE.Vector3((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10),
  });
}

function updateDebris(dt) {
  for (let i = debris.length - 1; i >= 0; i--) {
    const d = debris[i];
    d.t += dt;
    if (d.sink) {
      // sucked into the core, then the core detonates
      const k = Math.min(d.t / 0.55, 1);
      const e = k * k * k;
      d.mesh.position.lerpVectors(d.from, ORIGIN, e);
      d.mesh.scale.setScalar(Math.max(0.01, 0.85 * (1 - e)));
      d.mesh.rotateZ(dt * 14);
      if (k < 1) continue;
      burst(ORIGIN, 420, 9, d.color, RED);
      shockwave(RED);
      shockwave(d.color, 0.12);
      impact({ shake: 0.45, aberration: 0.04, glitch: 0.9, flash: 'rgba(255,77,109,0.55)' });
      sfx.destroy();
      pulse = 1.4;
    } else {
      // shattered by a pod wipe: tumble away and fade
      d.vel.y -= 5 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;
      d.mesh.material.opacity = Math.max(0, 1 - d.t / 1.6);
      if (Math.random() < 0.4) spark(d.mesh.position, _v.set(0, 0, 0), RED, 0.6, 2);
      if (d.t < 1.6) continue;
    }
    disposeCard(d.mesh);
    debris.splice(i, 1);
  }
}

// ------------------------------------------------------------------ pod wipe: emptyDir vs PVC
const ARMOR = {
  emptyDir: { label: 'PAPER', cls: 'paper', note: 'emptyDir', tip: 'Files die with the pod',
    long: 'emptyDir is a scratch folder inside the pod. If the pod is deleted, every file on it is gone.' },
  pvc: { label: 'STEEL', cls: 'steel', note: 'PVC', tip: 'Files survive pod restarts',
    long: 'A PersistentVolumeClaim is a disk that lives outside the pod. Files survive when the pod is deleted.' },
  minio: { label: 'VAULT', cls: 'vault', note: 'MinIO', tip: 'Files live in object storage',
    long: 'Files are stored in MinIO object storage, so the app pod holds no data at all.' },
};
let lastPod = null;
let signalLost = false;
let polling = false;
const shortPod = (p) => (p && p.length > 24 ? `…${p.slice(-22)}` : p || '?');

function setServer(h) {
  $('server').classList.toggle('lost', !h);
  if (!h) { $('mode').textContent = 'SIGNAL LOST'; $('srv-status').textContent = 'Not responding'; return; }
  $('mode').textContent = api.mode === 'live' ? 'ONLINE' : 'DEMO';
  $('srv-status').textContent = api.mode === 'live' ? 'Connected' : 'Demo — no server connected';
  if (h.quota !== quotaBytes) { quotaBytes = h.quota || null; updateStorage(); }
  $('pod').textContent = h.pod || '—';
  $('pod').title = h.pod || '';
  const a = h.storage === 'minio' ? ARMOR.minio : ARMOR[h.volume];
  const armor = $('armor');
  armor.className = `armor ${a ? a.cls : ''}`;
  armor.textContent = a ? `◆ ${a.label} (${a.note})` : '◆ UNKNOWN VOLUME';
  armor.title = a ? a.tip : 'The backend did not report its volume type';
  $('armor-note').textContent = a ? a.long : 'The server did not say which kind of volume it uses.';
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const h = await api.health();
    if (!h) {
      if (!signalLost && started) {
        sfx.error();
        impact({ glitch: 0.7, aberration: 0.02 });
        feed({ icon: '!', tag: 'SIGNAL LOST', name: 'Server not responding…', kind: 'bad' });
      }
      signalLost = true;
      setServer(null);
      return;
    }
    signalLost = false;
    setServer(h);
    const previous = lastPod;
    lastPod = h.pod;
    if (started && previous && h.pod && h.pod !== previous) await podWiped(previous, h.pod);
  } finally {
    polling = false;
  }
}

async function podWiped(oldPod, newPod) {
  const before = [...cards.keys()];
  showcase({
    duration: 1900,
    run: () => {
      showBanner('POD TERMINATED', `${shortPod(oldPod)} → ${shortPod(newPod)}`, 'danger');
      sfx.alarm();
      impact({ shake: 0.4, aberration: 0.04, glitch: 1, flash: 'rgba(255,77,109,0.6)' });
      pulse = 1;
    },
  });
  feed({ icon: '☠', tag: 'POD WIPED', name: `new pod ${shortPod(newPod)}`, kind: 'bad' });
  let files;
  try { files = await api.list(); } catch { return; }
  const names = new Set(files.map((f) => f.name));
  const lost = before.filter((n) => !names.has(n));
  showcase({
    duration: 2800,
    run: () => {
      if (lost.length) {
        lost.forEach(shatterCard);
        sfx.shatter();
        impact({ shake: 0.3, aberration: 0.03, glitch: 0.6 });
        showBanner('DATA LOST', `${lost.length} file${lost.length === 1 ? '' : 's'} died with the pod — emptyDir is temporary`, 'danger');
        lost.forEach((n) => feed({ icon: '✖', tag: 'LOST', name: n, kind: 'bad' }));
      } else {
        raiseShield();
        sfx.shield();
        showBanner('DATA SURVIVED', before.length ? `${before.length} files intact — the volume outlived the pod` : 'No files were at risk', 'safe');
      }
      award(game.wipe(lost.length > 0, before.length > 0));
      refresh();
    },
  });
}

function simulateWipe() {
  if (api.mode !== 'demo' || !started) return;
  api.simulateWipe();
  sfx.ui();
  feed({ icon: '$', tag: 'KUBECTL', name: `delete pod ${shortPod(lastPod)}`, kind: 'sys' });
  poll();
  setTimeout(poll, 1800);
}

function cycleVolume() {
  if (api.mode !== 'demo') return;
  const v = api.cycleVolume();
  $('sim-volume-label').textContent = `VOLUME: ${v.toUpperCase()}`;
  sfx.ui();
  const a = ARMOR[v];
  feed({ icon: '◆', tag: 'ARMOR', name: `${a.label} — ${a.tip}`, kind: 'sys' });
  poll();
}
$('sim-wipe').addEventListener('click', simulateWipe);
$('sim-volume').addEventListener('click', cycleVolume);

// ------------------------------------------------------------------ input
const pointer = { ndc: new THREE.Vector2(2, 2), dirty: false, downX: 0, downY: 0, over: false };
const raycaster = new THREE.Raycaster();
const reticle = $('reticle');
let hovered = null;
let dragging = false;
const dragNdc = new THREE.Vector2();

const toNdc = (e, out) => out.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);

canvas.addEventListener('pointermove', (e) => {
  toNdc(e, pointer.ndc);
  pointer.dirty = true;
  pointer.over = true;
  reticle.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
  reticle.classList.toggle('on', started);
});
canvas.addEventListener('pointerleave', () => {
  pointer.ndc.set(2, 2);
  pointer.dirty = true;
  pointer.over = false;
  reticle.classList.remove('on');
});
// Capture phase, so this runs before the orbit controls see the press.
canvas.addEventListener('pointerdown', (e) => {
  pointer.downX = e.clientX;
  pointer.downY = e.clientY;
  if (!started || pendingDestroy || pendingDownload || e.button !== 0) return;
  toNdc(e, pointer.ndc);
  if (pickPacket() >= 0 || pickCrate()) { controls.enabled = false; return; }
  const hit = pickCard();
  if (hit) { controls.enabled = false; beginGrab(hit.name, e); }
}, { capture: true });
canvas.addEventListener('pointerup', (e) => {
  if (!started || pendingDestroy || pendingDownload) return;
  if (Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY) > 6) return; // orbit or item drag
  toNdc(e, pointer.ndc);
  const pk = pickPacket();
  if (pk >= 0) { catchPacket(pk, performance.now()); return; }
  if (pickCrate()) { openCrate(); return; }
  const hit = pickCard();
  if (hit) askDownload(hit.name);
});

function pickCard() {
  raycaster.setFromCamera(pointer.ndc, camera);
  const hits = raycaster.intersectObjects([...cards.values()].map((c) => c.mesh), false);
  return hits.length ? cards.get(hits[0].object.userData.name) : null;
}

function updateHover() {
  if (!started) return;
  if (grab?.active) {
    reticle.classList.toggle('lock', grab.over);
    reticle.style.setProperty('--rc', '#ff4d6d');
    return;
  }
  if (!pointer.dirty && !packets.length && !crate.visible) return;
  pointer.dirty = false;
  const target = !pointer.over ? null : pickPacket() >= 0 ? 'packet' : pickCrate() ? 'crate' : null;
  const hit = pointer.over && !target ? pickCard() : null;
  if (hit !== hovered) {
    if (hovered) hoverItem(hovered.name, false);
    hovered = hit;
    if (hovered) {
      hoverItem(hovered.name, true);
      document.querySelectorAll('.slot').forEach((s) => {
        if (s.dataset.name === hovered.name) s.classList.add('hot');
      });
      sfx.hover();
    }
  }
  reticle.classList.toggle('lock', !!(target || hit));
  if (target) reticle.style.setProperty('--rc', '#ffc857');
  else if (hit) reticle.style.setProperty('--rc', RARITIES[hit.rarity].color);
  else reticle.style.removeProperty('--rc');
}

const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
let dragDepth = 0;
function setDragging(on) {
  dragging = on;
  document.body.classList.toggle('dragging', on);
}
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (!dragDepth) sfx.ui();
  dragDepth++;
  setDragging(true);
});
addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  toNdc(e, dragNdc);
});
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDragging(false);
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  setDragging(false);
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) launch(files, toNdc(e, new THREE.Vector2()));
});

function openPicker() {
  sfx.ui();
  $('picker').click();
}
$('browse').addEventListener('click', openPicker);
$('picker').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (files.length) launch(files, { x: (Math.random() < 0.5 ? -1 : 1) * 0.55, y: -0.35 + Math.random() * 0.5 });
});

function toggleMute() {
  const off = sfx.toggle();
  $('mute').classList.toggle('off', off);
  $('mute-label').textContent = off ? 'SOUND OFF' : 'SOUND ON';
  if (!off) sfx.ui();
}
$('mute').addEventListener('click', toggleMute);

// ------------------------------------------------------------------ inventory + menu panels
let invOpen = false;
try { invOpen = localStorage.getItem('vortex-inv-open') === '1'; } catch { /* storage blocked */ }
function setInventory(open, sound = true) {
  invOpen = open;
  document.body.classList.toggle('inv-open', open);
  $('inv-toggle').setAttribute('aria-expanded', String(open));
  try { localStorage.setItem('vortex-inv-open', open ? '1' : '0'); } catch { /* storage blocked */ }
  if (sound) sfx.ui();
}
$('inv-toggle').addEventListener('click', () => setInventory(!invOpen));
$('inv-close').addEventListener('click', () => setInventory(false));

let menuOpen = false;
function selectTab(tab) {
  document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  document.querySelectorAll('.tab-panel').forEach((p) => { p.hidden = p.dataset.panel !== tab; });
  document.querySelector('.menu-body').scrollTop = 0;
}
function setMenu(open, tab = null) {
  menuOpen = open;
  document.body.classList.toggle('menu-open', open);
  $('menu').setAttribute('aria-hidden', String(!open));
  $('menu-toggle').setAttribute('aria-expanded', String(open));
  if (tab) selectTab(tab);
  if (open) { renderProfile(); $('menu-close').focus({ preventScroll: true }); }
  sfx.ui();
}
document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => { selectTab(b.dataset.tab); sfx.ui(); }));
$('menu-toggle').addEventListener('click', () => setMenu(!menuOpen));
$('menu-close').addEventListener('click', () => setMenu(false));
$('server').addEventListener('click', () => setMenu(true, 'server'));
$('logout').addEventListener('click', () => { api.logout(); location.reload(); });

addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target instanceof HTMLInputElement) return; // typing in the login form
  if (!document.body.classList.contains('authed')) return;
  if (!started) { e.preventDefault(); startGame(); return; }
  const key = e.key.toLowerCase();
  if (pendingDownload) {
    if (key === 'y') { e.preventDefault(); closeDownload(true); }
    else if (key === 'n' || key === 'escape') { e.preventDefault(); closeDownload(false); }
    return;
  }
  if (pendingDestroy) {
    if (key === 'y') { e.preventDefault(); closeConfirm(true); }
    else if (key === 'n' || key === 'escape') { e.preventDefault(); closeConfirm(false); }
    return;
  }
  if (key === 'escape') {
    if (grab?.active) endGrab(true);
    else if (menuOpen) setMenu(false);
    else if (invOpen) setInventory(false);
  }
  else if (key === 'h') setMenu(!menuOpen);
  else if (key === 'i') setInventory(!invOpen);
  else if (key === 'u') openPicker();
  else if (key === 'm') toggleMute();
  else if (key === 'o') openCrate();
  else if (key === 'c') cycleSkin();
  else if (key === 'w') simulateWipe();
  else if (key === 'v') cycleVolume();
});

// ------------------------------------------------------------------ resize
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = camera.aspect < 0.8 ? 78 : 55;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ main loop
const clock = new THREE.Clock();
let time = 0;
let energy = 0;
let pulse = 0;
let started = false;
let intro = 0;
let attract = 0;
const shakeBase = new THREE.Vector3();
const invProgress = $('inv-progress');

function startGame() {
  if (started) return;
  started = true;
  sfx.init();
  sfx.start();
  document.body.classList.add('playing');
  impact({ shake: 0.2, aberration: 0.03, glitch: 0.6, flash: 'rgba(56,232,255,0.45)' });
  shockwave(CYAN);
  shockwave(MAGENTA, 0.2);
  burst(ORIGIN, 400, 8, CYAN, MAGENTA);
  if (reduceMotion) intro = 1;
  if (api.mode === 'demo') {
    setTimeout(() => feed({ icon: '!', tag: 'DEMO', name: 'No server connected. Open MENU → SERVER to try a pod wipe', kind: 'sys' }), 1200);
  }
  award(game.inventory(cards.size));
}

function frame() {
  const dt = Math.min(clock.getDelta(), 0.1);
  time += dt;
  const now = performance.now();

  // camera: attract-mode orbit, then fly-in, then free orbit
  if (!started) {
    attract += dt * 0.08;
    camDir.set(Math.sin(attract), 0.3, Math.cos(attract)).normalize();
    camera.position.copy(camDir).multiplyScalar(CAM_FAR);
    camera.lookAt(0, 0, 0);
  } else if (intro < 1) {
    intro = Math.min(1, intro + dt / 2.2);
    camera.position.copy(camDir).multiplyScalar(lerp(CAM_FAR, CAM_DIST, easeOutCubic(intro)));
    camera.lookAt(0, 0, 0);
    if (intro === 1) controls.enabled = true;
  } else {
    controls.update();
  }
  world.updateMatrixWorld();

  const progress = updateUploads(dt);
  updatePackets(dt, now);
  updateDebris(dt);
  updateShield(dt);
  updateGrab();
  danger = damp(danger, pendingDestroy ? 1 : grab?.active ? (grab.over ? 1 : 0.35) : 0, 6, dt);
  energy = damp(energy, dragging ? 1 : uploads.length ? 0.65 : 0, 3, dt);
  pulse = damp(pulse, 0, 2.5, dt);

  // combo timer
  if (game.tick(now)) comboEl.classList.remove('on');
  if (game.combo >= 2) {
    $('combo-timer').style.width = `${Math.max(0, (game.comboUntil - now) / game.comboWindow) * 100}%`;
  }

  // core + rings
  coreUniforms.uTime.value = time;
  coreUniforms.uEnergy.value = energy + pulse;
  updatePalette(dt, time);
  coreUniforms.uA.value.copy(pal.a);
  coreUniforms.uB.value.copy(pal.b).lerp(pal.hot, energy).lerp(RED, danger);
  cage.material.color.copy(pal.b).lerp(RED, danger);
  rings.forEach((ring, i) => ring.material.color.copy(pal[`r${i}`]));
  vortexUniforms.uInner.value.copy(pal.inner).lerp(RED, danger);
  vortexUniforms.uOuter.value.copy(pal.outer);
  gridMat.uniforms.uColor.value.copy(pal.outer).lerp(RED, danger);
  core.scale.setScalar(1 + energy * 0.18 + pulse * 0.45 + Math.sin(time * 1.6) * 0.02);
  core.rotation.y += dt * 0.2;
  cage.rotation.x += dt * (0.12 + energy * 0.9);
  cage.rotation.y -= dt * (0.18 + energy * 1.2);
  cage.scale.setScalar(1 + pulse * 0.5);
  for (const ring of rings) {
    const k = dt * (1 + energy * 4 + pulse * 6 + danger * 5);
    ring.rotation.x += ring.userData.spin[0] * k;
    ring.rotation.y += ring.userData.spin[1] * k;
    ring.rotation.z += ring.userData.spin[2] * k;
  }
  gridMat.uniforms.uTime.value = time * (1 + energy * 2);

  // vortex
  vortexUniforms.uFlow.value += dt * (0.22 + energy * 1.6 + pulse);
  vortexUniforms.uSpin.value += dt * (0.5 + energy * 2.2 + pulse * 2);
  vortexUniforms.uEnergy.value = energy;

  // progress arc
  progressUniforms.uProgress.value = progress;
  document.body.classList.toggle('uploading', uploads.length > 0);
  invProgress.style.width = `${progress * 100}%`;
  progressUniforms.uOpacity.value = damp(progressUniforms.uOpacity.value, uploads.length ? 1 : 0, 5, dt);
  progressRing.quaternion.copy(camera.quaternion);
  progressRing.rotateZ(Math.PI / 2);
  progressRing.scale.setScalar(core.scale.x);

  // tractor stream while a file is dragged over the page
  if (dragging) {
    const src = ndcToWorldLocal(dragNdc, 7.5);
    for (let k = 0; k < 5; k++) {
      const p = src.clone().add(_v.randomDirection().multiplyScalar(0.5));
      _v.copy(p).multiplyScalar(-1.1);
      spark(p, _v, k % 2 ? MAGENTA : CYAN, 0.9, 1.0);
    }
  }

  updateCards(dt, time);
  updateCrate(dt, time);
  updateHover();
  updateSparks(dt);

  const lit = [...cards.values()].find((c) => c.hover);
  beam.visible = !!lit;
  if (lit) {
    beamGeo.attributes.position.setXYZ(1, lit.pos.x, lit.pos.y, lit.pos.z);
    beamGeo.attributes.position.needsUpdate = true;
    beam.material.color.copy(lit.color);
  }

  for (const s of shocks) {
    if (!s.visible) continue;
    s.userData.t += dt / 1.3;
    const t = s.userData.t;
    if (t < 0) { s.material.opacity = 0; continue; }
    s.scale.setScalar(1 + easeOutCubic(Math.min(t, 1)) * 11);
    s.material.opacity = Math.max(0, 1 - t);
    s.quaternion.copy(camera.quaternion);
    if (t >= 1) s.visible = false;
  }

  // post fx
  fx.shake = damp(fx.shake, 0, 6, dt);
  fx.aberration = damp(fx.aberration, 0, 4, dt);
  fx.glitch = damp(fx.glitch, 0, 5, dt);
  rgbShift.uniforms.uAmount.value = 0.0018 + energy * 0.004 + fx.aberration;
  rgbShift.uniforms.uGlitch.value = fx.glitch;
  rgbShift.uniforms.uTime.value = time;
  bloom.strength = 0.7 + energy * 0.25 + pulse * 0.6;

  shakeBase.copy(camera.position);
  if (fx.shake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * fx.shake;
    camera.position.y += (Math.random() - 0.5) * fx.shake;
  }
  composer.render();
  camera.position.copy(shakeBase);
}

// ------------------------------------------------------------------ boot
async function boot() {
  $('rarity-strip').replaceChildren(...RARITIES.map((r, i) => {
    const s = el('span', `r-${r.key}`, r.label);
    const prev = i ? RARITIES[i - 1].max : 0;
    s.append(el('small', null, i === RARITIES.length - 1 ? `${formatBytes(prev)}+` : `< ${formatBytes(r.max)}`));
    return s;
  }));
  $('legend').replaceChildren(...RARITIES.map((r) => el('span', `r-${r.key}`, r.label)));
  if (matchMedia('(pointer: coarse)').matches) $('press').textContent = 'TAP TO START';
  if (sfx.muted) { $('mute').classList.add('off'); $('mute-label').textContent = 'SOUND OFF'; }

  await Promise.race([
    Promise.all([
      document.fonts.load('900 72px Orbitron'),
      document.fonts.load('600 38px Rajdhani'),
      document.fonts.load('26px "Share Tech Mono"'),
    ]),
    new Promise((r) => setTimeout(r, 1500)),
  ]).catch(() => {});

  await api.init();
  let signingOut = false;
  api.onUnauthorized = (reason = '') => {
    if (signingOut) return;
    signingOut = true;
    api.logout();
    const gone = /not found/i.test(reason);
    showBanner(gone ? 'ACCOUNT LOST' : 'SIGNED OUT',
      gone ? 'Your account was stored on the wiped disk (emptyDir) — create it again' : 'Your session expired — please sign in again',
      'danger');
    feed({ icon: '!', tag: 'SESSION', name: gone ? 'Account no longer exists on this server' : 'Session expired', kind: 'bad' });
    setTimeout(() => location.reload(), gone ? 4500 : 2000);
  };
  $('server').classList.add(api.mode);
  document.body.classList.add(api.mode);
  if (api.mode === 'demo') {
    $('sim').hidden = false;
    $('sim-volume-label').textContent = `VOLUME: ${api.demo.volume.toUpperCase()}`;
  }
  const health = await api.health();
  lastPod = health?.pod || null;
  setServer(health);

  renderer.setAnimationLoop(frame);
  document.body.classList.add('loaded');
  $('start').addEventListener('click', startGame);

  const user = (await api.restoreSession()) || (await showLogin());
  await enterAs(user);
}

// Load one player's progress and files, then show the start screen.
async function enterAs(user) {
  game.init(user.username);
  $('pname').textContent = user.username;
  updatePlayer();
  applySkin(true);
  updateCrateCount();
  setInventory(invOpen, false);
  $('continue').textContent = game.uploads
    ? `WELCOME BACK, ${user.username} · LV ${game.level} ${game.rank}`
    : `WELCOME, ${user.username}`;
  await refresh();
  document.body.classList.add('authed');
  setInterval(poll, 3000);
}

function showLogin() {
  return new Promise((resolve) => {
    const form = $('login-form');
    const errorEl = $('login-error');
    let mode = 'login';
    const setMode = (m) => {
      mode = m;
      document.querySelectorAll('[data-auth]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.auth === m)));
      $('confirm-field').hidden = m !== 'register';
      $('login-pass').autocomplete = m === 'register' ? 'new-password' : 'current-password';
      $('login-submit').textContent = m === 'register' ? 'CREATE ACCOUNT' : 'SIGN IN';
      errorEl.textContent = '';
    };
    const fail = (message) => {
      errorEl.textContent = message;
      form.classList.remove('shake');
      void form.offsetWidth;
      form.classList.add('shake');
      sfx.error();
    };
    document.querySelectorAll('[data-auth]').forEach((b) => b.addEventListener('click', () => {
      setMode(b.dataset.auth);
      $('login-name').focus();
    }));
    $('login-note').textContent = api.mode === 'demo'
      ? 'Demo mode: no server is connected, so accounts and files are saved only in this browser. Every player gets their own vault and starts at level 1.'
      : 'Every player gets their own vault and starts at level 1.';
    setMode(api.mode === 'demo' && api.demoAccountCount() === 0 ? 'register' : 'login');
    $('login-submit').disabled = false;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      sfx.init();
      const name = $('login-name').value;
      const pass = $('login-pass').value;
      if (mode === 'register' && pass !== $('login-pass2').value) { fail('The two passwords do not match'); return; }
      $('login-submit').disabled = true;
      errorEl.textContent = '';
      try {
        const user = mode === 'register' ? await api.register(name, pass) : await api.login(name, pass);
        $('login-pass').value = '';
        $('login-pass2').value = '';
        sfx.ui();
        resolve(user);
      } catch (err) {
        fail(err.message);
      } finally {
        $('login-submit').disabled = false;
      }
    });
    setTimeout(() => $('login-name').focus(), 400);
  });
}

boot().catch((err) => {
  console.error(err);
  const b = $('boot');
  b.classList.add('fail');
  b.querySelector('.boot-label').textContent = `FAILED TO LOAD — ${err.message}`;
});
