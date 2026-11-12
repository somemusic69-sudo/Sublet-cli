#!/usr/bin/env node
import process from 'node:process';
import { join } from 'node:path';
import { BRAND, VERSION } from './version.js';
import { isLogLevel, LogFile, Logger, redactSecrets, type LogLevel } from './logger.js';
import { logsDir } from './config.js';
import { EXIT, UsageError } from './exitCodes.js';
import { applySettings, type ResolvedSettings } from './settings.js';
import { installFetchProxy } from './network/proxy.js';
import { colorEnabled } from './util/format.js';
import {
  cmdConfig,
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

/** `explicit` lists the flags typed on the command line, so settings never override them. */
type Parsed = { flags: GlobalFlags; command: string; explicit: Set<string> };

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
  '--no-browser': 'noBrowser',
  '--non-interactive': 'nonInteractive',
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
  '--log-level': 'logLevel',
  '--log-file': 'logFile',
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
    noBrowser: false,
    positionals: [],
  };
  let command = '';
  const explicit = new Set<string>();
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
      const booleanKey = Object.hasOwn(BOOLEAN_FLAGS, name) ? BOOLEAN_FLAGS[name] : undefined;
      if (booleanKey) {
        if (inline !== undefined && inline !== 'true' && inline !== 'false') throw new Error(`${name} accepts true or false`);
        const enabled = inline !== 'false';
        if (booleanKey === 'color') flags.color = !enabled;
        else (flags as unknown as Record<string, unknown>)[booleanKey] = enabled;
        explicit.add(booleanKey);
        continue;
      }
      const valueKey = Object.hasOwn(VALUE_FLAGS, name) ? VALUE_FLAGS[name] : undefined;
      if (valueKey) {
        const value = inline ?? (args[0]?.startsWith('--') ? undefined : args.shift());
        if (value == null || (!NUMERIC.has(valueKey) && !value.trim())) throw new Error(`${name} needs a value`);
        if (NUMERIC.has(valueKey)) (flags as unknown as Record<string, unknown>)[valueKey] = numberFlag(name, value, INTEGER.has(valueKey));
        else if (valueKey === 'logLevel' && !isLogLevel(value)) throw new Error(`--log-level must be one of debug, info, warn, error, silent; got "${value}"`);
        else (flags as unknown as Record<string, unknown>)[valueKey] = value;
        explicit.add(valueKey);
        continue;
      }
      throw new Error(`Unknown option: ${name}`);
    }
    if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}`);
    if (!command) command = arg.toLowerCase();
    else flags.positionals.push(arg);
  }
  if (explicit.has('slots') && (flags.slots! < 1 || flags.slots! > 16)) throw new Error('--slots must be between 1 and 16');
  if (explicit.has('context') && flags.context! < 256) throw new Error('--ctx must be at least 256 tokens');
  return { flags, command, explicit };
}

/** Commands that run for hours keep a rotating log file by default; quick commands only when asked. */
const LONG_RUNNING = new Set(['start', 'host', 'jobs']);

function logFileFor(command: string, flags: GlobalFlags): LogFile | null {
  const setting = flags.logFile?.trim();
  if (setting && /^(off|none|false|0)$/i.test(setting)) return null;
  if (!setting && !LONG_RUNNING.has(command)) return null;
  return new LogFile({ path: setting || join(logsDir(), 'agent.log') });
}

const COMMANDS = new Set(['login', 'doctor', 'start', 'host', 'jobs', 'status', 'logout', 'config']);

function reportError(error: unknown, json: boolean, code: number): void {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: message, exitCode: code })}\n`);
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseArgv(process.argv.slice(2));
  } catch (error) {
    const args = process.argv.slice(2);
    const beforeSeparator = args.slice(0, args.indexOf('--') >= 0 ? args.indexOf('--') : args.length);
    reportError(error, beforeSeparator.includes('--json') || beforeSeparator.includes('--json=true'), EXIT.USAGE);
    return EXIT.USAGE;
  }
  const { flags, command, explicit } = parsed;
  if (flags.version) {
    process.stdout.write(`${BRAND} agent v${VERSION}\n`);
    return EXIT.OK;
  }
  if (flags.help || !command) {
    process.stdout.write(`${globalHelp()}\n`);
    return EXIT.OK;
  }
  if (!COMMANDS.has(command)) {
    reportError(new UsageError(`Unknown command: ${command}. Run sublet --help.`), flags.json, EXIT.USAGE);
    return EXIT.USAGE;
  }
  let resolved: ResolvedSettings;
  try {
    // SUBLET_* variables and agent.json fill in every flag that was not typed.
    resolved = applySettings(flags, explicit);
    // config and logout are local recovery commands; a broken proxy must not prevent them.
    if (command !== 'config' && command !== 'logout') await installFetchProxy();
  } catch (error) {
    reportError(error, flags.json, EXIT.USAGE);
    return EXIT.USAGE;
  }
  const level: LogLevel = flags.verbose ? 'debug' : isLogLevel(flags.logLevel) ? flags.logLevel : 'info';
  const logger = new Logger({
    level,
    json: flags.json,
    color: flags.color && colorEnabled(process.stderr),
    file: logFileFor(command, flags),
  });
  if (logger.file) logger.debug(`${BRAND} agent v${VERSION} ${command}`, { node: process.versions.node, platform: `${process.platform}/${process.arch}`, pid: process.pid });
  try {
    switch (command) {
      case 'login': return await cmdLogin(flags, logger);
      case 'doctor': return await cmdDoctor(flags, logger);
      case 'start': return await cmdStart(flags, logger);
      case 'host': return await cmdHost(flags, logger);
      case 'jobs': return await cmdJobs(flags, logger);
      case 'status': return await cmdStatus(flags, logger);
      case 'logout': return await cmdLogout(flags, logger);
      case 'config': return await cmdConfig(flags, logger, resolved);
      default: return EXIT.USAGE;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? EXIT.USAGE : EXIT.ERROR;
    if (flags.json) process.stdout.write(`${JSON.stringify({ ok: false, error: redactSecrets(message), exitCode: code })}\n`);
    logger.error(message);
    if (error instanceof Error && error.stack) logger.debug(error.stack);
    return code;
  }
}

const invoked = process.argv[1] && (process.argv[1].endsWith('index.js') || process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('sublet-cli') || process.argv[1].endsWith('sublet'));
if (invoked) {
  let fatal = false;
  let fatalTimer: NodeJS.Timeout | undefined;
  // Stop serving after an unexpected failure, allowing existing SIGTERM cleanup a bounded grace period.
  process.on('unhandledRejection', (reason) => {
    if (fatal) return;
    fatal = true;
    process.stderr.write(`Unexpected error: ${redactSecrets(reason instanceof Error ? reason.stack || reason.message : String(reason))}\n`);
    process.exitCode = EXIT.ERROR;
    fatalTimer = setTimeout(() => process.exit(EXIT.ERROR), 5_000);
    fatalTimer.unref();
    process.emit('SIGTERM');
  });
  main().then((code) => {
    process.exitCode = fatal ? EXIT.ERROR : code;
    if (fatalTimer) clearTimeout(fatalTimer);
  }).catch((error) => {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.stack || error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}

export { main };
