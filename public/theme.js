/* Party themes: sets <html data-party="…">, swaps the greeting text and draws the background decorations.
   Colors, fonts and layouts live in themes.css. */
(function () {
  const META = {
    general: { name: 'General', emoji: '👋', band: 'Hello, we’re playing', free: 'Free', desc: 'Classic name-tag look' },
    christmas: { name: 'Christmas', emoji: '🎄', band: 'Merry & bright — we’re playing', free: '🎄 Free', desc: 'Snowfall, red & gold' },
    fun: { name: 'Fun activities', emoji: '🎉', band: 'Let’s play!', free: '🎉 Free', desc: 'Bright, bubbly, confetti' },
    team: { name: 'Team building', emoji: '🤝', band: 'Team challenge', free: '🤝 Free', desc: 'Clean dashboard style' },
    youth: { name: 'Youthful', emoji: '⚡', band: 'Let’s gooo!', free: '⚡ FREE', desc: 'Neon stickers on dark' },
    minimal: { name: 'Minimal', emoji: '◻️', band: 'Now playing', free: 'Free', desc: 'Black & white, no fuss' },
  };
  const root = document.documentElement;
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let drawn = null;

  function decorate(t) {
    if (drawn === t) return;
    drawn = t;
    let layer = document.querySelector('.deco');
    if (layer) layer.remove();
    const make = { christmas: snow, fun: confetti, youth: glow }[t];
    if (!make || !document.body) return;
    layer = document.createElement('div');
    layer.className = 'deco';
    layer.setAttribute('aria-hidden', 'true');
    layer.innerHTML = make();
    document.body.prepend(layer);
  }
  const rnd = (a, b) => a + Math.random() * (b - a);
  function pieces(n, fn) {
    let h = '';
    for (let i = 0; i < n; i++) h += fn(i);
    return h;
  }
  function fallStyle(minDur, maxDur) {
    // With reduced motion the pieces sit still, scattered over the page.
    return reduced()
      ? `left:${rnd(0, 100)}%;top:${rnd(0, 100)}%;`
      : `left:${rnd(0, 100)}%;animation-duration:${rnd(minDur, maxDur)}s;animation-delay:-${rnd(0, maxDur)}s;`;
  }
  function snow() {
    return pieces(42, () => `<i class="flake" style="${fallStyle(9, 20)}font-size:${rnd(0.6, 1.5)}rem;opacity:${rnd(0.35, 0.9)}">${Math.random() < 0.35 ? '❄' : '•'}</i>`);
  }
  function confetti() {
    const c = ['#ffe14d', '#22c55e', '#3b82f6', '#a855f7', '#ffffff', '#ff3d8b'];
    return pieces(30, (i) => `<i class="bit" style="${fallStyle(10, 22)}background:${c[i % c.length]};width:${rnd(6, 12)}px;height:${rnd(10, 18)}px;border-radius:${Math.random() < 0.4 ? '50%' : '2px'}"></i>`);
  }
  function glow() {
    return '<i class="blob b1"></i><i class="blob b2"></i><i class="blob b3"></i>';
  }

  function apply(t) {
    t = META[t] ? t : 'general';
    root.dataset.party = t;
    document.querySelectorAll('[data-band]').forEach((el) => { el.textContent = META[t].band; });
    if (document.body) decorate(t);
    else document.addEventListener('DOMContentLoaded', () => decorate(t), { once: true });
  }
  const current = () => (META[root.dataset.party] ? root.dataset.party : 'general');
  window.Theme = { META, apply, current, free: () => META[current()].free, list: () => Object.keys(META) };
})();
