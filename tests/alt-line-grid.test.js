/* Tests for the alt line grid (Hoops 1.1.0). Run: node --test tests/alt-line-grid.test.js
   No dependencies and no build step. The real index.html script is loaded into a Node vm with a stub
   DOM, so these tests exercise the shipped code, not a copy of it. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const SCRIPT = HTML.match(/<script>([\s\S]*?)<\/script>/)[1];

/* A stand in for any DOM node: every property is another stand in, every call returns one. */
function dummy() {
  const kids = {};
  const f = function () {};
  return new Proxy(f, {
    get: (t, k) => {
      if (k === 'then' || typeof k === 'symbol') return k === Symbol.toPrimitive ? () => '' : undefined;
      if (k === 'classList') return { add() {}, remove() {}, contains: () => false, toggle() {} };
      if (k === 'dataset') return {};
      return kids[k] || (kids[k] = dummy());
    },
    set: (t, k, v) => { kids[k] = v; return true; },
    apply: () => dummy(),
  });
}

async function loadApp() {
  const handlers = {};
  const store = {};
  const sandbox = {
    document: {
      querySelector: () => dummy(), querySelectorAll: () => [], createElement: () => dummy(), body: dummy(), documentElement: dummy(),
      visibilityState: 'visible', addEventListener: (type, fn) => { (handlers[type] = handlers[type] || []).push(fn); },
    },
    navigator: {}, location: { protocol: 'http:' }, console: { log() {}, error() {}, warn() {} },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } },
    fetch: async () => { throw new Error('offline'); }, confirm: () => true,
    setTimeout, clearTimeout, AbortController, Intl, URL, Blob, Headers, Date, Math, JSON,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SCRIPT, ctx);
  await new Promise(r => setTimeout(r, 60)); // let init() fail its offline fetches
  const run = code => vm.runInContext(code, ctx);
  const fire = (type, ev) => Promise.all((handlers[type] || []).map(fn => fn(ev)));
  return { ctx, run, fire };
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b} +/- ${tol}, got ${a}`);
const rebGames = vals => vals.map(v => ({ reb: v }));
/* Ten games that vary less than Poisson allows, so the Poisson branch is chosen (needs 8 or more games). */
const POISSON_LOGS = rebGames([5, 6, 5, 6, 5, 6, 5, 6, 5, 6]);

/* ------------------------------------------------------------------ 1. hand checked grid values */
test('Poisson, rebounds 5.5 priced 50/50 no vig: fitted mean is about 5.67', async () => {
  const { run } = await loadApp();
  const r = run(`(() => { const sh = gridShape('rebounds', ${JSON.stringify(POISSON_LOGS)}, 5.5); return { fam: sh.fam, mu: gridMu(sh, 5.5, 0.5) }; })()`);
  assert.equal(r.fam, 'poisson');
  near(r.mu, 5.67, 0.005, 'mean');
});

test('Poisson at mean 5.67: over 6.5 is about 34.1% (+193), over 4.5 is about 66.8% (-201)', async () => {
  const { run } = await loadApp();
  const r = run(`(() => {
    const sh = gridShape('rebounds', ${JSON.stringify(POISSON_LOGS)}, 5.5), mu = gridMu(sh, 5.5, 0.5);
    const a = gridSides(sh, mu, 6.5), b = gridSides(sh, mu, 4.5);
    return { o65: a.q, am65: probToAm(a.q), o45: b.q, am45: probToAm(b.q), pushes: [a.push, b.push] };
  })()`);
  near(r.o65, 0.341, 0.001, 'over 6.5');
  near(r.am65, 193, 1.5, 'over 6.5 odds');
  near(r.o45, 0.668, 0.001, 'over 4.5');
  near(r.am45, -201, 1.5, 'over 4.5 odds');
  assert.deepEqual(JSON.parse(JSON.stringify(r.pushes)), [0, 0], 'half point lines never push');
});

test('the grid ladder prices the same rungs from the same fit', async () => {
  const { run } = await loadApp();
  const rows = run(`(() => {
    const P = { name: 'T P', pk: 't p', market: 'rebounds', books: { draftkings: { title: 'DraftKings', over: { pt: 5.5, pr: -110 }, under: { pt: 5.5, pr: -110 } } } };
    const E = { market: 'rebounds', P, line: 5.5, started: false, model: { games: ${JSON.stringify(POISSON_LOGS)} } };
    return gridLadder(E).rows.map(R => ({ line: R.line, q: R.q }));
  })()`);
  const at = L => rows.find(R => R.line === L).q;
  near(at(6.5), 0.341, 0.001);
  near(at(4.5), 0.668, 0.001);
  near(at(5.5), 0.5, 0.0005);
});

test('integer line: a push is refunded, not counted as a loss', async () => {
  const { run } = await loadApp();
  const r = run(`(() => {
    const sh = gridShape('rebounds', ${JSON.stringify(POISSON_LOGS)}, 6), mu = gridMu(sh, 6, 0.5), s = gridSides(sh, mu, 6);
    return { mu, over: s.over, under: s.under, push: s.push, q: s.q, pmf6: poisPmf(6, mu), evRefund: evSide(s, 'over', -110) };
  })()`);
  near(r.mu, 6.163, 0.005, 'mean at the integer line');
  near(r.q, 0.5, 1e-6, 'no vig over chance excludes the push');
  near(r.over, 0.4199, 0.0005); near(r.under, 0.4199, 0.0005);
  near(r.push, 0.1603, 0.0005, 'push chance');
  near(r.push, r.pmf6, 1e-9, 'push chance is the pmf at the line');
  near(r.over + r.under + r.push, 1, 1e-9);
  near(r.evRefund, 0.4199 * (100 / 110) - 0.4199, 0.0005, 'EV with the push refunded');
  assert.ok(r.evRefund > -0.05, 'a push counted as a loss would give about -19.8%');
});

test('under 5 games: the per stat default spread is used', async () => {
  const { run } = await loadApp();
  const r = run(`(() => ({
    reb3: gridShape('rebounds', ${JSON.stringify(rebGames([4, 9, 2]))}, 6),
    reb4: gridShape('rebounds', ${JSON.stringify(rebGames([4, 9, 2, 11]))}, 6),
    reb5: gridShape('rebounds', ${JSON.stringify(rebGames([4, 9, 2, 11, 3]))}, 6),
    none: gridShape('assists', [], 5.5),
    pts3: gridShape('points', ${JSON.stringify([20, 31, 12].map(v => ({ pts: v })))}, 24.5),
    ptsNone: gridShape('points', [], 24.5),
    rDef: MARKETS.rebounds.r, rAst: MARKETS.assists.r, rPts: MARKETS.points.r,
  }))()`);
  for (const k of ['reb3', 'reb4']) { assert.equal(r[k].fam, 'nb'); assert.equal(r[k].r, r.rDef, k + ' uses the default dispersion exactly'); assert.equal(r[k].src, 'stat default'); }
  assert.notEqual(r.reb5.r, r.rDef, 'with 5 games the player own spread starts to count');
  assert.match(r.reb5.src, /last 5 games/);
  assert.equal(r.none.r, r.rAst); assert.equal(r.none.src, 'stat default');
  /* default spread for continuous stats: cv^2 = 1/mean + 1/r, where the mean is the sample mean, or the line with no games */
  near(r.pts3.cv, Math.sqrt(1 / 21 + 1 / r.rPts), 1e-9, 'continuous stats fall back to the default spread too (sample mean 21)');
  near(r.ptsNone.cv, Math.sqrt(1 / 24.5 + 1 / r.rPts), 1e-9, 'with no games the line is the reference mean');
  assert.equal(r.pts3.fam, 'normal'); assert.equal(r.pts3.src, 'stat default');
});

test('continuous stats round trip: the solved mean puts the over at the no vig chance', async () => {
  const { run } = await loadApp();
  const r = run(`(() => ['points', 'pra'].map(m => {
    const col = MARKETS[m].col, g = [22,31,18,27,25,19,34,21,26,23,29,17].map(v => ({ [col]: v }));
    const sh = gridShape(m, g, 24.5), mu = gridMu(sh, 24.5, 0.47);
    return { fam: sh.fam, q: gridSides(sh, mu, 24.5).q };
  }))()`);
  for (const x of r) near(x.q, 0.47, 1e-6, x.fam);
});

/* ------------------------------------------------------------------ 3a. old saved data */
const OLD_PROPS = () => ({
  t: 1760000000000,
  props: {
    'jalen test|rebounds': { name: 'Jalen Test', pk: 'jalen test', market: 'rebounds', books: {
      draftkings: { title: 'DraftKings', over: { pt: 8.5, pr: -110 }, under: { pt: 8.5, pr: -110 } },
      fanduel: { title: 'FanDuel', over: { pt: 8.5, pr: -105 }, under: { pt: 8.5, pr: -125 } } } },
  },
});

test('old saved props (one line per book) load unchanged and price with no migration', async () => {
  const { run } = await loadApp();
  const old = OLD_PROPS();
  const r = await run(`(async () => {
    await DB.set('props:g1', ${JSON.stringify(old)});
    S.props = {}; await loadCached();
    const loaded = S.props.g1, P = loaded.props['jalen test|rebounds'];
    const E = { market: 'rebounds', P, line: 8.5, started: false, model: null, cons: propConsensus(P) };
    const gl = gridLadder(E);
    return { loaded: JSON.parse(JSON.stringify(loaded)), rungs: bookRungs(P.books.draftkings).length, rows: gl.rows.length, mainBest: gl.rows.find(R => R.main).best, html: gridHtml(E).length > 0 };
  })()`);
  assert.deepEqual(r.loaded, old, 'loadCached returned the stored object as is');
  assert.equal(JSON.stringify(r.loaded).includes('alts'), false, 'no alts field was added');
  assert.equal(r.rungs, 1);
  assert.ok(r.rows >= 7, 'still builds a ladder around the main line');
  assert.ok(r.mainBest, 'main line still gets a best price');
  assert.equal(r.html, true);
});

test('alternate lines are stored on the book without changing its main line', async () => {
  const { run } = await loadApp();
  const r = await run(`(async () => {
    const o = (name, pt, price) => ({ name, description: 'Jalen Test', point: pt, price });
    getJSON = async () => ({ headers: new Headers({ 'x-requests-remaining': '400', 'x-requests-last': '2' }), json: { bookmakers: [
      { key: 'draftkings', title: 'DraftKings', markets: [
        { key: 'player_rebounds_alternate', outcomes: [o('Over', 6.5, -250), o('Over', 10.5, 260), o('Over', 8.5, -112)] },
        { key: 'player_rebounds', outcomes: [o('Over', 8.5, -110), o('Under', 8.5, -110)] }] },
      { key: 'fanduel', title: 'FanDuel', markets: [{ key: 'player_rebounds', outcomes: [o('Over', 8.5, -105), o('Under', 8.5, -125), o('Over', 9.5, 170), o('Under', 9.5, -210)] }] } ] } });
    const a = await fetchProps('k', 'e', ['rebounds'], 'us', true);
    return JSON.parse(JSON.stringify(a.props['jalen test|rebounds'].books));
  })()`);
  assert.deepEqual(r.draftkings.over, { pt: 8.5, pr: -110 });
  assert.deepEqual(r.draftkings.under, { pt: 8.5, pr: -110 });
  assert.deepEqual(r.draftkings.alts.map(x => x.pt), [6.5, 10.5], 'the main line is not repeated in alts');
  assert.deepEqual(r.fanduel.over, { pt: 8.5, pr: -105 });
  assert.deepEqual(r.fanduel.alts, [{ pt: 9.5, over: 170, under: -210 }]);
});

/* ------------------------------------------------------------------ 3b. export and import */
const BETS = () => [
  { id: 'b1', gameId: 'g1', ymd: '2026-10-24', start: '2026-10-24T23:00:00Z', aid: '1', pk: 'jalen test', name: 'Jalen Test', market: 'rebounds', side: 'over', line: 8.5, price: -105, book: 'draftkings', stake: 1, note: '', placedAt: 1760000200000, fair: 0.52, evFair: 0.04, evCons: 0.03, consMu: 8.6, modelMu: 8.9, status: 'open', pl: 0, clv: null },
  { id: 'b2', gameId: 'g2', ymd: '2026-10-24', start: '2026-10-24T23:30:00Z', aid: '2', pk: 'other guy', name: 'Other Guy', market: 'points', side: 'under', line: 22.5, price: 110, book: 'fanduel', stake: 0.5, note: 'x', placedAt: 1760000100000, fair: 0.49, evFair: 0.02, evCons: 0.01, consMu: 22.9, modelMu: null, status: 'open', pl: 0, clv: null },
];
const HIST = () => ({ 'g1|jalen test|rebounds': [{ t: 1760000000000, mu: 8.6, line: 8.5, n: 2 }] });
const withAlts = () => { const p = OLD_PROPS(); p.props['jalen test|rebounds'].books.draftkings.alts = [{ pt: 6.5, over: -250, under: null }, { pt: 10.5, over: 260, under: null }]; return p; };

test('Export then Import round-trips picks and price history, with multi line props in storage', async () => {
  const a = await loadApp();
  let exported = null;
  a.ctx.downloadText = (name, txt) => { exported = { name, txt }; };
  a.run(`S.bets = ${JSON.stringify(BETS())}; S.hist = ${JSON.stringify(HIST())}; S.props = { g1: ${JSON.stringify(withAlts())} };`);
  await a.fire('click', { target: { closest: () => ({ dataset: { act: 'exportAll' } }) } });
  assert.ok(exported, 'export ran');
  const j = JSON.parse(exported.txt);
  assert.deepEqual(Object.keys(j), ['app', 'version', 'exportedAt', 'bets', 'hist'], 'backup shape is unchanged from 1.0.0');
  assert.equal(j.app, 'hoops');
  assert.equal(j.version, a.run('VERSION'));
  assert.equal(exported.txt.includes('alts'), false, 'alternate lines stay in IndexedDB and are not in the backup');
  assert.deepEqual(j.bets, BETS()); assert.deepEqual(j.hist, HIST());

  const b = await loadApp(); // a fresh install
  await b.fire('change', { target: { id: 'importFile', files: [{ text: async () => exported.txt }] } });
  const back = JSON.parse(b.run('JSON.stringify({ bets: S.bets, hist: S.hist })'));
  assert.deepEqual(back.bets, [...BETS()].sort((x, y) => y.placedAt - x.placedAt));
  assert.deepEqual(back.hist, HIST());
});

test('Import still accepts a 1.0.0 backup and leaves saved props (and their alts) alone', async () => {
  const a = await loadApp();
  const v1 = JSON.stringify({ app: 'hoops', version: '1.0.0', exportedAt: '2026-10-17T00:00:00.000Z', bets: BETS(), hist: HIST() });
  a.run(`S.props = { g1: ${JSON.stringify(withAlts())} };`);
  await a.fire('change', { target: { id: 'importFile', files: [{ text: async () => v1 }] } });
  assert.equal(a.run('S.bets.length'), 2);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(S.props)')), { g1: withAlts() });
});

/* ------------------------------------------------------------------ 3c. War Room / outbound data */
test('Hoops sends nothing to War Room: the only outbound hosts are ESPN and The Odds API', () => {
  assert.equal(/war[\s_-]?room/i.test(HTML), false, 'no War Room code in index.html');
  const hosts = new Set((SCRIPT.match(/https?:\/\/[^/'"`\s$]+/g) || []).map(u => u.replace(/^https?:\/\//, '')));
  assert.deepEqual([...hosts].sort(), ['api.the-odds-api.com', 'site.api.espn.com']);
});

test('picks and board EV ignore alternate lines: best price, pick and EV are the same with or without alts', async () => {
  const a = await loadApp();
  const out = a.run(`(() => {
    const g = { id: 'g1', ymd: '2099-01-02', date: '2099-01-02T23:00:00Z', home: '1', away: '2', state: 'pre' };
    S.dayData['2099-01-02'] = { games: [g] };
    const run = props => { S.props = { g1: { t: Date.now(), props } }; S.evals = {}; const E = evalProp(g, props['jalen test|rebounds']); return JSON.parse(JSON.stringify({ best: E.best, top: E.top, pick: E.pick, line: E.line, cons: E.cons })); };
    const plain = ${JSON.stringify(OLD_PROPS().props)}, alt = ${JSON.stringify(withAlts().props)};
    alt['jalen test|rebounds'].books.fanduel.alts = [{ pt: 12.5, over: 900, under: null }, { pt: 4.5, over: null, under: 1200 }];
    return { plain: run(plain), alt: run(alt) };
  })()`);
  assert.deepEqual(out.alt, out.plain);
});

/* ------------------------------------------------------------------ 2. labelling */
test('the grid labels its fair odds as market fair with no model blend', async () => {
  const { run } = await loadApp();
  const html = run(`(() => {
    const P = ${JSON.stringify(OLD_PROPS().props['jalen test|rebounds'])};
    const E = { market: 'rebounds', P, line: 8.5, started: false, model: null, cons: propConsensus(P) };
    return gridHtml(E) + sliderReadout(Object.assign({}, E, { model: null }), 8.5);
  })()`);
  assert.match(html, /Market fair/);
  assert.match(html, /no model/);
  assert.match(html, /market fair<\/small>/);
});

/* ------------------------------------------------------------------ 4. version and cache move together */
test('the version in index.html and the service worker cache name change together', () => {
  const v = SCRIPT.match(/const VERSION = '([^']+)'/)[1];
  const c = SW.match(/const CACHE = '([^']+)'/)[1];
  assert.equal(c, `hoops-${v}`, 'cache name must be hoops-<VERSION> so installed phones fetch the new shell');
  assert.equal(v, '1.1.0');
  assert.match(SW, /SHELL = \[[^\]]*'\.\/index\.html'/, 'index.html is in the cached shell');
  assert.match(SW, /k\.startsWith\('hoops-'\) && k !== CACHE/, 'old caches are deleted on activate');
  assert.match(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), new RegExp(`^- \\d{4}-\\d{2}-\\d{2}, ${v.replace(/\./g, '\\.')}:`, 'm'), 'CHANGELOG has a dated line for this version');
});

test('no em or en dashes in the shipped files', () => {
  for (const f of ['index.html', 'sw.js', 'CHANGELOG.md', 'tests/alt-line-grid.test.js']) {
    const dashes = new RegExp('[' + String.fromCharCode(0x2013, 0x2014) + ']');
    assert.equal(dashes.test(fs.readFileSync(path.join(ROOT, f), 'utf8')), false, f);
  }
});
