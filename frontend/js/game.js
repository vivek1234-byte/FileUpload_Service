// Game layer: loot rarity, XP, levels, combos, achievements, crates and skins.
// Progress is kept in localStorage, so it survives a reload in the same browser.

const STORE_PREFIX = 'vortex-progress-v2:'; // + player name, so every account has its own progress
const COMBO_WINDOW = 8000; // ms between stored uploads to keep a combo alive
const ACHIEVEMENT_XP = 50;
const UPLOADS_PER_CRATE = 5;

const MB = 1024 * 1024;
export const RARITIES = [
  { key: 'common',    label: 'COMMON',    color: '#c8d3dc', max: 100 * 1024, xp: 10 },
  { key: 'uncommon',  label: 'UNCOMMON',  color: '#4dff88', max: MB,        xp: 25 },
  { key: 'rare',      label: 'RARE',      color: '#3da5ff', max: 10 * MB,   xp: 60 },
  { key: 'epic',      label: 'EPIC',      color: '#b05cff', max: 100 * MB,  xp: 150 },
  { key: 'legendary', label: 'LEGENDARY', color: '#ff9a1f', max: Infinity,  xp: 400 },
];
export const rarityIndex = (size) => RARITIES.findIndex((r) => size < r.max);
export const rarityOf = (size) => RARITIES[rarityIndex(size)];

export const ACHIEVEMENTS = {
  first_upload:  { title: 'FIRST DROP',     desc: 'Upload your first file' },
  combo3:        { title: 'TRIPLE THREAT',  desc: 'Reach a x3 upload combo' },
  combo5:        { title: 'UNSTOPPABLE',    desc: 'Reach a x5 upload combo' },
  rare:          { title: 'RARE FIND',      desc: 'Upload a file over 1 MB' },
  legendary:     { title: 'LEGENDARY LOOT', desc: 'Upload a file over 100 MB' },
  hoarder:       { title: 'HOARDER',        desc: 'Hold 10 files in the vault' },
  retriever:     { title: 'RETRIEVER',      desc: 'Download a file back' },
  level5:        { title: 'DATA RUNNER',    desc: 'Reach level 5' },
  packet_hunter: { title: 'PACKET HUNTER',  desc: 'Catch 10 data packets' },
  unboxed:       { title: 'UNBOXED',        desc: 'Open a loot crate' },
  demolition:    { title: 'DEMOLITION',     desc: 'Destroy a file in the core' },
  survivor:      { title: 'SURVIVOR',       desc: 'Keep your files through a pod wipe' },
  lesson:        { title: 'LESSON LEARNED', desc: 'Lose files when an emptyDir pod dies' },
};

// Core skins, won from loot crates. Colours: core a/b, drag glow, vortex inner/outer, the three rings.
export const SKINS = {
  default:   { name: 'NEON CORE',   rarity: 0, a: 0x8a5cff, b: 0x38e8ff, hot: 0xff3df0, inner: 0xff3df0, outer: 0x38e8ff, rings: [0xff3df0, 0x38e8ff, 0x8a5cff] },
  toxic:     { name: 'TOXIC',       rarity: 1, a: 0x1f7a3a, b: 0x7dff4d, hot: 0xe6ff3d, inner: 0xe6ff3d, outer: 0x3dff9a, rings: [0xe6ff3d, 0x3dff9a, 0x1fbf6a] },
  glacier:   { name: 'GLACIER',     rarity: 1, a: 0x2a5a8a, b: 0xbff4ff, hot: 0xffffff, inner: 0xe0fbff, outer: 0x6ad4ff, rings: [0xffffff, 0x6ad4ff, 0x9ab8ff] },
  abyss:     { name: 'ABYSS',       rarity: 2, a: 0x1a2bff, b: 0x3dd6ff, hot: 0x9af0ff, inner: 0x6a5cff, outer: 0x1ab0ff, rings: [0x6a5cff, 0x1ab0ff, 0x3dd6ff] },
  solar:     { name: 'SOLAR FLARE', rarity: 3, a: 0xff5a1f, b: 0xffc857, hot: 0xffffff, inner: 0xffe08a, outer: 0xff6a3d, rings: [0xffc857, 0xff6a3d, 0xff3d1f] },
  bloodmoon: { name: 'BLOOD MOON',  rarity: 3, a: 0x5a0010, b: 0xff2a4d, hot: 0xff9a9a, inner: 0xff3d6a, outer: 0x8a0f2a, rings: [0xff2a4d, 0xff9a9a, 0x8a0f2a] },
  phantom:   { name: 'PHANTOM',     rarity: 4, a: 0x55557a, b: 0xffffff, hot: 0xb05cff, inner: 0xffffff, outer: 0xb05cff, rings: [0xffffff, 0xb05cff, 0x8a8aff] },
  prism:     { name: 'PRISM',       rarity: 4, prism: true, a: 0x8a5cff, b: 0x38e8ff, hot: 0xff3df0, inner: 0xff3df0, outer: 0x38e8ff, rings: [0xff3df0, 0x38e8ff, 0x8a5cff] },
};
const CRATE_WEIGHTS = [46, 26, 15, 9, 4]; // chance per rarity
const CRATE_XP = [50, 80, 120, 200, 400]; // XP cache / duplicate value per rarity

const RANKS = [[1, 'ROOKIE'], [3, 'COURIER'], [5, 'DATA RUNNER'], [8, 'VAULT KEEPER'], [12, 'ARCHON'], [20, 'VOID LORD']];

export const xpToNext = (level) => 100 + (level - 1) * 75;

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || null; } catch { return null; }
}

const SAVED_NUMBERS = ['level', 'xp', 'uploads', 'retrieved', 'bestCombo', 'packets', 'crates', 'cratesOpened', 'destroyed', 'wipes'];

const fresh = () => ({
  level: 1, xp: 0, uploads: 0, retrieved: 0, bestCombo: 0, packets: 0, crates: 0, cratesOpened: 0,
  destroyed: 0, wipes: 0, unlocked: [], skins: ['default'], skin: 'default', combo: 0, comboUntil: 0,
});

export const game = {
  storeKey: null,
  level: 1,
  xp: 0,
  uploads: 0,
  retrieved: 0,
  bestCombo: 0,
  packets: 0,
  crates: 0,
  cratesOpened: 0,
  destroyed: 0,
  wipes: 0,
  unlocked: [],
  skins: ['default'],
  skin: 'default',
  combo: 0,
  comboUntil: 0,
  comboWindow: COMBO_WINDOW,

  // Load the progress of one player. A new player starts at level 1 with 0 XP.
  init(player) {
    Object.assign(this, fresh());
    this.storeKey = STORE_PREFIX + player.toLowerCase();
    const saved = load(this.storeKey);
    if (!saved) return;
    for (const k of SAVED_NUMBERS) {
      if (Number.isFinite(saved[k])) this[k] = saved[k];
    }
    if (Array.isArray(saved.unlocked)) this.unlocked = saved.unlocked.filter((id) => id in ACHIEVEMENTS);
    if (Array.isArray(saved.skins)) this.skins = ['default', ...saved.skins.filter((id) => id in SKINS && id !== 'default')];
    if (this.skins.includes(saved.skin)) this.skin = saved.skin;
  },

  save() {
    const data = { unlocked: this.unlocked, skins: this.skins, skin: this.skin };
    for (const k of SAVED_NUMBERS) data[k] = this[k];
    if (!this.storeKey) return;
    try { localStorage.setItem(this.storeKey, JSON.stringify(data)); } catch { /* storage blocked */ }
  },

  get rank() {
    return RANKS.filter(([lvl]) => this.level >= lvl).at(-1)[1];
  },

  get multiplier() {
    return Math.min(1 + Math.max(this.combo - 1, 0) * 0.5, 4);
  },

  // Drop the combo once its window has passed. Returns true when it just ended.
  tick(now) {
    if (this.combo && now > this.comboUntil) {
      this.combo = 0;
      return true;
    }
    return false;
  },

  // A file finished uploading.
  stored(size, now) {
    this.combo = now < this.comboUntil ? this.combo + 1 : 1;
    this.comboUntil = now + COMBO_WINDOW;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.uploads++;
    const crate = this.uploads % UPLOADS_PER_CRATE === 0;
    if (crate) this.crates++;

    const index = rarityIndex(size);
    const rarity = RARITIES[index];
    const multiplier = this.multiplier;
    const gained = Math.round(rarity.xp * multiplier);

    const unlocked = [];
    this._unlock('first_upload', unlocked);
    if (this.combo >= 3) this._unlock('combo3', unlocked);
    if (this.combo >= 5) this._unlock('combo5', unlocked);
    if (index >= 2) this._unlock('rare', unlocked);
    if (index >= 4) this._unlock('legendary', unlocked);

    return { rarity, index, gained, multiplier, crate, combo: this.combo, ...this._award(gained, unlocked) };
  },

  // A flying data packet was caught. chain = catches in a row.
  packet(chain) {
    this.packets++;
    const value = Math.min(5 * chain, 25);
    const unlocked = [];
    if (this.packets >= 10) this._unlock('packet_hunter', unlocked);
    return { value, ...this._award(value, unlocked) };
  },

  // Roll a loot crate. Returns a skin, or XP when the roll is common or a duplicate.
  openCrate() {
    if (this.crates <= 0) return null;
    this.crates--;
    this.cratesOpened++;
    let roll = Math.random() * CRATE_WEIGHTS.reduce((a, b) => a + b, 0);
    let rarity = 0;
    while (roll >= CRATE_WEIGHTS[rarity]) roll -= CRATE_WEIGHTS[rarity++];

    const pool = Object.keys(SKINS).filter((id) => SKINS[id].rarity === rarity && id !== 'default');
    const fresh = pool.filter((id) => !this.skins.includes(id));
    const unlocked = [];
    this._unlock('unboxed', unlocked);

    if (fresh.length) {
      const id = fresh[Math.floor(Math.random() * fresh.length)];
      this.skins.push(id);
      this.skin = id;
      return { kind: 'skin', id, name: SKINS[id].name, rarity, ...this._award(0, unlocked) };
    }
    const dupe = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
    const amount = CRATE_XP[rarity];
    return { kind: 'xp', amount, rarity, duplicate: !!dupe, id: dupe, name: dupe ? SKINS[dupe].name : null, ...this._award(amount, unlocked) };
  },

  equip(id) {
    if (!this.skins.includes(id)) return false;
    this.skin = id;
    this.save();
    return true;
  },

  // Equip the next owned skin. Returns its id.
  nextSkin() {
    const owned = Object.keys(SKINS).filter((id) => this.skins.includes(id));
    this.skin = owned[(owned.indexOf(this.skin) + 1) % owned.length];
    this.save();
    return this.skin;
  },

  retrievedFile() {
    this.retrieved++;
    const unlocked = [];
    this._unlock('retriever', unlocked);
    return this._award(0, unlocked);
  },

  destroyedFile() {
    this.destroyed++;
    const unlocked = [];
    this._unlock('demolition', unlocked);
    return this._award(0, unlocked);
  },

  // The server pod was replaced. lost = files disappeared with it.
  wipe(lost, hadFiles) {
    this.wipes++;
    const unlocked = [];
    if (lost) this._unlock('lesson', unlocked);
    else if (hadFiles) this._unlock('survivor', unlocked);
    return this._award(0, unlocked);
  },

  inventory(count) {
    const unlocked = [];
    if (count >= 10) this._unlock('hoarder', unlocked);
    return this._award(0, unlocked);
  },

  _unlock(id, list) {
    if (this.unlocked.includes(id)) return false;
    this.unlocked.push(id);
    list.push(id);
    return true;
  },

  _award(base, unlocked) {
    const before = this.level;
    this._addXp(base + unlocked.length * ACHIEVEMENT_XP);
    if (this.level >= 5 && this._unlock('level5', unlocked)) this._addXp(ACHIEVEMENT_XP);
    this.save();
    return { unlocked, levelUp: this.level > before ? this.level : 0 };
  },

  _addXp(n) {
    this.xp += n;
    while (this.xp >= xpToNext(this.level)) {
      this.xp -= xpToNext(this.level);
      this.level++;
    }
  },
};
