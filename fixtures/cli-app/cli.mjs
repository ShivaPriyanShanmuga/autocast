#!/usr/bin/env node
// A dependency-free CLI that exercises everything a VT renderer can get
// wrong: colour, carriage-return redraw, the alternate screen, a process
// that never exits, and a non-zero exit.
//
// Escapes are written as \x1b deliberately. A literal ESC byte in a source
// file is invisible and does not survive copy/paste.

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [, , command, ...args] = process.argv;

async function greet() {
  const name = args[0] ?? 'there';
  process.stdout.write(`${C.green}hello${C.reset} ${C.bold}${name}${C.reset}\n`);
  process.stdout.write(`${C.cyan}ready${C.reset}\n`);
}

async function build() {
  const width = 24;
  for (let pct = 0; pct <= 100; pct += 10) {
    const filled = Math.round((pct / 100) * width);
    const bar = '#'.repeat(filled) + '-'.repeat(width - filled);
    process.stdout.write(`\rbuilding [${bar}] ${String(pct).padStart(3)}%`);
    await sleep(80);
  }
  process.stdout.write(`\n${C.green}build complete${C.reset}\n`);
}

async function watch() {
  process.stdout.write(`${C.yellow}watching for changes${C.reset}\n`);
  process.stdout.write('listening on :4242\n');
  // Never exits. This is the "dev server" case: the pipeline must kill it.
  setInterval(() => process.stdout.write('.'), 250);
}

async function dash() {
  process.stdout.write('\x1b[?1049h'); // enter alternate screen
  try {
    for (let tick = 0; tick < 8; tick++) {
      process.stdout.write('\x1b[2J\x1b[H'); // clear + home
      process.stdout.write('┌─ autocast dash ─┐\n');
      process.stdout.write(`│ tick ${String(tick).padStart(2)}         │\n`);
      process.stdout.write(`│ cpu  ${String(30 + tick * 5).padStart(2)}%        │\n`);
      process.stdout.write('└─────────────────┘\n');
      await sleep(120);
    }
  } finally {
    process.stdout.write('\x1b[?1049l'); // leave alternate screen
  }
  process.stdout.write('dash done\n');
}

async function fail() {
  process.stderr.write('boom: something went wrong\n');
  process.exitCode = 2;
}

const commands = { greet, build, watch, dash, fail };

const run = commands[command];
if (!run) {
  process.stderr.write(`unknown command: ${command ?? '(none)'}\n`);
  process.stderr.write(`usage: cli.mjs <${Object.keys(commands).join('|')}>\n`);
  process.exit(1);
}
await run();
