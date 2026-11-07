#!/usr/bin/env node
import process from 'node:process';
import { BRAND, VERSION } from './version.js';
import { Logger } from './logger.js';
import {
  cmdDoctor,
  cmdHost,
  cmdJobs,
  cmdLogin,
  cmdLogout,
  cmdStart,
  cmdStatus,
  globalHelp,
  type GlobalFlags,
} from './commands.js';

type Parsed = { flags: GlobalFlags; command: string };

const BOOLEAN_FLAGS: Record<string, keyof GlobalFlags> = {
  '--json': 'json',
  '--verbose': 'verbose',
  '--no-color': 'color',
  '--simulation': 'simulation',
  '--fix': 'fix',
  '--force': 'force',
  '--once': 'once',
  '--no-install': 'noInstall',
  '--watch': 'watch',
  '--require-checksum': 'requireChecksum',
  '--help': 'help',
  '--version': 'version',
};

const VALUE_FLAGS: Record<string, keyof GlobalFlags> = {
  '--server': 'server',
  '--key': 'token',
  '--token': 'token',
  '--ws-path': 'wsPath',
  '--model': 'model',
  '--ctx': 'context',
  '--slots': 'slots',
  '--price': 'price',
  '--price-in': 'priceIn',
  '--price-out': 'priceOut',
  '--gpu': 'gpu',
  '--vram': 'vram',
  '--tok-s': 'tokPerSec',
  '--claim': 'claim',
  '--timeout': 'timeoutMs',
};

const NUMERIC = new Set<keyof GlobalFlags>(['context', 'slots', 'price', 'priceIn', 'priceOut', 'vram', 'tokPerSec', 'timeoutMs']);
const INTEGER = new Set<keyof GlobalFlags>(['context', 'slots', 'vram']);

function numberFlag(name: string, raw: string, integer: boolean): number {
  const value = raw.trim() ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) throw new Error(`${name} expects a number, got "${raw}"`);
  if (value < 0) throw new Error(`${name} must not be negative, got "${raw}"`);
  if (integer && !Number.isInteger(value)) throw new Error(`${name} expects a whole number, got "${raw}"`);
  return value;
}

export function parseArgv(argv: string[]): Parsed {
  const flags: GlobalFlags = {
    json: false,
    verbose: false,
    color: true,
    simulation: false,
    fix: false,
    force: false,
    once: false,
    noInstall: false,
    help: false,
    version: false,
    watch: false,
    requireChecksum: false,
    positionals: [],
  };
  let command = '';
  const args = [...argv];
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--') {
      flags.positionals.push(...args.splice(0));
      break;
    }
    if (arg === '-h') { flags.help = true; continue; }
    if (arg === '-v' || arg === '-V') { flags.version = true; continue; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
      const booleanKey = BOOLEAN_FLAGS[name];
      if (booleanKey) {
        if (booleanKey === 'color') flags.color = false;
        else (flags as unknown as Record<string, unknown>)[booleanKey] = true;
        continue;
      }
      const valueKey = VALUE_FLAGS[name];
      if (valueKey) {
        const value = inline ?? (args[0]?.startsWith('--') ? undefined : args.shift());
        if (value == null) throw new Error(`${name} needs a value`);
        if (NUMERIC.has(valueKey)) (flags as unknown as Record<string, unknown>)[valueKey] = numberFlag(name, value, INTEGER.has(valueKey));
        else (flags as unknown as Record<string, unknown>)[valueKey] = value;
        continue;
      }
      throw new Error(`Unknown option: ${name}`);
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg.toLowerCase();
    else flags.positionals.push(arg);
  }
  return { flags, command };
}

async function main(): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${globalHelp()}\n`);
    return 2;
  }
  const { flags, command } = parsed;
  if (flags.version) {
    process.stdout.write(`${BRAND} agent v${VERSION}\n`);
    return 0;
  }
  if (flags.help || !command) {
    process.stdout.write(`${globalHelp()}\n`);
    return 0;
  }
  const logger = new Logger({
    level: flags.verbose ? 'debug' : 'info',
    json: flags.json,
    color: flags.color && Boolean(process.stderr.isTTY),
  });
  try {
    switch (command) {
      case 'login': return await cmdLogin(flags, logger);
      case 'doctor': return await cmdDoctor(flags, logger);
      case 'start': return await cmdStart(flags, logger);
      case 'host': return await cmdHost(flags, logger);
      case 'jobs': return await cmdJobs(flags, logger);
      case 'status': return await cmdStatus(flags, logger);
      case 'logout': return await cmdLogout(flags, logger);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${globalHelp()}\n`);
        return 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
    logger.error(message);
    if (flags.verbose && error instanceof Error && error.stack) logger.debug(error.stack);
    return 1;
  }
}

const invoked = process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('kiln-agent') || process.argv[1].endsWith('kiln'));
if (invoked) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { main };
