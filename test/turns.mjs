// Unit tests for src/remote/turns.js — one chat summary per turn of work.
//   node test/turns.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TurnTracker, headline, screenSummary } = require('../src/remote/turns.js');
const { parseEntry } = require('../src/remote/transcripts.js');

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) console.log('PASS  ' + name);
  else {
    console.error('FAIL  ' + name + (detail === undefined ? '' : '  → ' + JSON.stringify(detail).slice(0, 400)));
    failures++;
  }
};

function tracker() {
  const posts = [];
  const prompts = [];
  const progress = [];
  const t = new TurnTracker({
    post: (termId, msg, opts) => posts.push({ termId, msg, opts }),
    prompt: (termId, e) => prompts.push(e.text),
    progress: (termId, info) => progress.push(info),
  });
  return { t, posts, prompts, progress };
}

// Transcript lines as Claude Code writes them.
const T0 = Date.parse('2026-09-27T01:00:00Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const lines = [
  { type: 'ai-title', aiTitle: 'Fix the flaky login test' },
  { type: 'user', uuid: 'u1', timestamp: at(0), origin: { kind: 'human' }, message: { role: 'user', content: 'fix the flaky login test' } },
  { type: 'assistant', uuid: 'a1', timestamp: at(2), message: { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look at the test.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'test/login.spec.ts' } }] } },
  { type: 'user', uuid: 'r1', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', content: '…' }] } },
  { type: 'assistant', uuid: 'a2', timestamp: at(8), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'test/login.spec.ts' } }] } },
  { type: 'assistant', uuid: 'a3', timestamp: at(12), message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- login' } }] } },
  { type: 'assistant', uuid: 'a4', timestamp: at(40), message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '## Fixed\n\nThe test raced the session cookie. I now wait for the redirect before asserting. All 42 login tests pass.\n\n- test/login.spec.ts: await the redirect' }] } },
  { type: 'system', subtype: 'turn_duration', uuid: 's1', timestamp: at(41), durationMs: 41000 },
];
const events = lines.flatMap(parseEntry);
check('transcript lines become turn events',
  events.map((e) => e.type).join() === 'title,user,text,tool,tool,tool,text,endHint,end', events.map((e) => e.type));

{
  const { t, posts, prompts, progress } = tracker();
  t.onEvents('t1', events.slice(0, 4));
  check('a typed prompt is shown once', prompts.join() === 'fix the flaky login test');
  check('nothing is posted while the agent works', posts.length === 0);
  check('progress reports steps while working', progress.at(-1) && progress.at(-1).steps === 1, progress.at(-1));
  t.onEvents('t1', events.slice(4));
  check('the turn end posts exactly one summary', posts.length === 1, posts.length);
  const m = posts[0].msg;
  check('summary text is the final reply', m.kind === 'summary' && m.text.startsWith('## Fixed'));
  check('headline is the first paragraph, plain', m.headline === 'Fixed', m.headline);
  check('steps are listed, counted by kind', m.steps.length === 3 && m.stats.edit === 1 && m.stats.command === 1 && m.stats.read === 1, m.stats);
  check('duration comes from turn_duration', m.stats.durationMs === 41000);
  check('live turns notify', posts[0].opts.notify === true);
  check('progress is cleared at the end', progress.at(-1) === null);
  check('session title is kept', t.title('t1') === 'Fix the flaky login test');
}

{
  // Older Claude Code without turn_duration: end_turn + quiet ends the turn.
  const { t, posts } = tracker();
  const noDuration = events.filter((e) => e.type !== 'end').map((e) => ({ ...e, ts: e.ts ? Date.now() - 10000 : e.ts }));
  t.onEvents('t1', noDuration);
  check('without turn_duration nothing is posted yet', posts.length === 0);
  t.tick('t1', { idle: false });
  check('…not while the terminal is busy', posts.length === 0);
  t.tick('t1', { idle: true });
  check('end_turn + idle + quiet ends the turn', posts.length === 1 && posts[0].msg.text.startsWith('## Fixed'));
}

{
  // A new prompt while a turn is open closes the old one as interrupted.
  const { t, posts } = tracker();
  t.onEvents('t1', events.slice(1, 5));
  t.onEvents('t1', [{ type: 'user', id: 'tx:u2', ts: T0 + 60000, text: 'stop, do the signup test instead' }]);
  check('an interrupted turn still gets a summary', posts.length === 1 && posts[0].msg.interrupted === true, posts.map((p) => p.msg));
}

{
  // Binding an existing transcript: only the last few turns, silently.
  const { t, posts, prompts } = tracker();
  const many = [];
  for (let i = 0; i < 6; i++) {
    many.push({ type: 'user', id: `tx:u${i}`, ts: T0 + i * 1000, text: `task ${i}` });
    many.push({ type: 'text', id: `tx:a${i}`, ts: T0 + i * 1000 + 1, text: `done ${i}` });
    many.push({ type: 'end', id: `tx:e${i}`, ts: T0 + i * 1000 + 2, durationMs: 2 });
  }
  t.onEvents('t1', many, { backfill: true });
  check('backfill keeps the last 3 turns', posts.map((p) => p.msg.text).join() === 'done 3,done 4,done 5', posts.map((p) => p.msg.text));
  check('backfill does not notify', posts.every((p) => p.opts.notify === false));
  check('backfill does not repeat old prompts', prompts.length === 0);
}

check('headline shortens long replies at a sentence', (() => {
  const h = headline('This is the first sentence and it is quite long indeed, going on. ' + 'x '.repeat(200));
  return h.endsWith('…') && h.length <= 241;
})());

const shellOut = 'npm test\r\n\x1b[32m✓\x1b[0m 42 passing (3s)\r\n\r\ndone\r\nPS C:\\work> ';
check('shell summary drops the echo and the prompt', screenSummary(shellOut, 'npm test') === '✓ 42 passing (3s)\ndone', screenSummary(shellOut, 'npm test'));

console.log(failures ? `\nTURNS: ${failures} FAILURE(S)` : '\nTURNS: ALL PASSED');
process.exit(failures ? 1 : 0);
