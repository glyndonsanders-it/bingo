/* Category library: built-in starter lists the host can edit, rename, duplicate, delete, import and export. */
(function () {
  const KEY = 'hb2:cats';
  const BUILT_IN = [
    { id: 'icebreakers', name: 'Icebreakers', title: 'Find Someone Who…', p: ['Speaks 3+ languages', 'Born in another country', 'Has a pet', 'Plays an instrument', 'Has run a race', 'Is left-handed', 'Loves spicy food', 'Has met a celebrity', 'Can juggle', 'Doesn’t drink coffee', 'Has a tattoo', 'Has been on TV', 'Plays a sport weekly', 'Has a signature dish', 'Has lived in 3+ cities', 'Is an only child', 'Reads every week', 'Loves karaoke', 'Has broken a bone', 'Collects something', 'Has gone skydiving', 'Is afraid of spiders', 'Has a twin', 'Wakes up before 6am', 'Knows a magic trick'] },
    { id: 'team', name: 'Team & work', title: 'Team Bingo', p: ['Works remotely', 'Here 5+ years', 'Started this month', 'Prefers tea to coffee', 'Has presented to 100+ people', 'Mentors someone', 'Eats lunch at their desk', 'Has a side project', 'Uses dark mode', 'Has 100+ unread emails', 'Commutes by bike', 'Has changed careers', 'Speaks at meetups', 'Keeps a plant at work', 'Has a standing desk', 'Takes walking meetings', 'Has worked abroad', 'Writes in a notebook', 'Loves a spreadsheet', 'Dislikes early meetings', 'Has a hidden talent', 'Listens to podcasts', 'Studied something else', 'Has taught a class', 'Has a favorite shortcut'] },
    { id: 'party', name: 'Party', title: 'Party Bingo', p: ['Came with a plus-one', 'Knows the host from school', 'Brought a snack', 'Can dance salsa', 'Loves board games', 'Birthday this month', 'Is wearing red', 'Has danced on a table', 'Can whistle loudly', 'Visited 10+ countries', 'Loves pineapple pizza', 'Plays video games', 'Dislikes their middle name', 'Can do a cartwheel', 'Sings in the shower', 'Has a green thumb', 'Knows a good joke', 'Hasn’t checked their phone', 'Photographs their food', 'Has gone camping', 'Is a night owl', 'Can wiggle their ears', 'Has been in a play', 'Has a song to share', 'Speaks another language'] },
    { id: 'classroom', name: 'Classroom', title: 'Class Bingo', p: ['Walks to school', 'Has a sibling here', 'Plays chess', 'Loves math', 'Read 5+ books this year', 'Likes broccoli', 'Has a cat', 'Has a dog', 'Speaks another language', 'Can draw well', 'Plays football', 'Birthday in summer', 'Loves rainy days', 'Has been on a plane', 'Can do a handstand', 'Has a favorite teacher', 'Likes to bake', 'Plays an instrument', 'Has visited a farm', 'Has a nickname', 'Writes stories', 'Is learning to code', 'Knows a card trick', 'Loves science', 'Has moved house'] },
  ];
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  function sanitize(list) {
    if (!Array.isArray(list)) return null;
    const out = list
      .filter((c) => c && typeof c === 'object')
      .map((c, i) => ({
        id: clean(c.id, 40) || 'c' + Date.now().toString(36) + i,
        name: clean(c.name, 30) || 'Untitled',
        title: clean(c.title, 40) || 'Find Someone Who…',
        p: (Array.isArray(c.p) ? c.p : []).map((x) => clean(x, 80)).filter(Boolean).slice(0, 300),
      }));
    return out.length ? out : null;
  }
  function load() {
    try {
      const s = sanitize(JSON.parse(localStorage.getItem(KEY)));
      if (s) return s;
    } catch (e) {}
    return copy(BUILT_IN);
  }
  function save(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  }
  window.Cats = { load, save, sanitize, builtIn: () => copy(BUILT_IN), newId: () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6) };
})();
