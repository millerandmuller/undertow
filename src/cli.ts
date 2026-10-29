import { deviceLogin, validateStoredToken, type Tokens } from './auth/auth.ts';
import { loginAccount } from './auth/accounts.ts';
import { chatSettings, probeWithRestore, restoreBaseline } from './actuator/settings.ts';
import { EventSub } from './eventsub/client.ts';
import { loadConfig, selectedProfile } from './config.ts';
import { startRun } from './run.ts';
import { Helix } from './util/helix.ts';
import { atomicJson, readJson } from './util/files.ts';
import { startOverlayServer } from './overlay/server.ts';
import { readdir, readFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { loadAccounts } from './loadtest/accounts.ts';
import { runLoadtest } from './loadtest/runner.ts';
import { parseLoadtestRate } from './loadtest/scheduler.ts';

function stateDirectory(): string {
  return process.env.UNDERTOW_STATE_DIR ?? '.undertow';
}

function statePath(name: string): string {
  return `${stateDirectory()}/${name}`;
}

const baselineFile = statePath('baseline.json');
let eventSub: EventSub | undefined;
let stopRun: (() => Promise<void>) | undefined;
let loadtestAbort: AbortController | undefined;

function config(): { clientId: string; login: string } {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const login = process.env.TWITCH_CHANNEL_LOGIN;
  if (!clientId) throw new Error('TWITCH_CLIENT_ID is required');
  if (!login) throw new Error('TWITCH_CHANNEL_LOGIN is required');
  return { clientId, login };
}

async function context() {
  const tokenPath = statePath('tokens.json');
  let tokens: Tokens;
  try {
    tokens = await readJson<Tokens>(tokenPath);
  } catch {
    throw new Error(`No Undertow tokens found at ${tokenPath}; run npm run login first`);
  }
  const { clientId, login } = config();
  const validated = await validateStoredToken(
    tokens,
    clientId,
    login,
    (next) => atomicJson(tokenPath, next),
    fetch,
    process.env.TWITCH_CLIENT_SECRET,
  );
  Object.assign(validated.tokens, validated.identity);
  const activeTokens = validated.tokens;
  const identity = validated.identity;
  const helix = new Helix(
    clientId,
    activeTokens,
    (next) => atomicJson(statePath('tokens.json'), next),
    { clientSecret: process.env.TWITCH_CLIENT_SECRET },
  );
  return {
    identity,
    helix,
    api: chatSettings(helix, identity.user_id),
  };
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value));
}

async function login(): Promise<void> {
  const { clientId, login: expectedLogin } = config();
  const account = optionValue(process.argv.slice(3), '--account');
  if (account) {
    const tokens = await loginAccount({
      clientId,
      broadcasterLogin: expectedLogin,
      accountLogin: account,
      stateDirectory: stateDirectory(),
      device: { onCode: (code, uri) => console.log(`Open ${uri} and enter code ${code}`) },
    });
    console.log(`Validated ${tokens.login}; scopes: ${tokens.scope.join(', ')}`);
    return;
  }
  const tokens = await deviceLogin(
    clientId,
    expectedLogin,
    (value) => atomicJson(statePath('tokens.json'), value),
    { onCode: (code, uri) => console.log(`Open ${uri} and enter code ${code}`) },
  );
  console.log(`Validated ${tokens.login}; scopes: ${tokens.scope.join(', ')}`);
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function probe(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.log(
      'Plan: validate token, save chat settings baseline, set slow mode to 10 seconds, ' +
        'read back, restore baseline, verify. Pass --yes to run.',
    );
    return;
  }
  try {
    await access(baselineFile);
    console.warn('WARNING: existing baseline was preserved; restore it before probing.');
    return;
  } catch {
    // A missing baseline is the normal probe path.
  }
  const { helix, api } = await context();
  const restored = await probeWithRestore(
    api,
    baselineFile,
    () => api.update({ slow_mode: true, slow_mode_wait_time: 10 }).then(() => undefined),
    async () => printJson(await api.get()),
  );
  printJson(restored);
  console.log(`Ratelimit-Remaining: ${helix.remaining}`);
}

async function run(): Promise<void> {
  const port = requestedOverlayPort(process.argv.slice(3));
  const live = process.argv.includes('--live');
  if (live && process.argv.includes('--dry')) {
    throw new Error('Choose either --dry or --live');
  }
  if (live) {
    try {
      await access(baselineFile);
      throw new Error('unrestored previous run: run npm run restore first');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('unrestored')) throw error;
    }
  }
  const runArgs = process.argv.slice(3);
  const profile = await loadConfig(selectedProfile(runArgs));
  const { helix, identity } = await context();
  const handle = await startRun({
    helix,
    broadcasterId: identity.user_id,
    profile,
    stateDirectory: stateDirectory(),
    dryRun: !live,
    verbose: process.argv.includes('--verbose'),
    recordPath: recordPath(),
  });
  let overlay: Awaited<ReturnType<typeof startOverlayServer>> | undefined;
  stopRun = async () => {
    await handle.stop();
    await overlay?.stop();
  };
  if (port !== null) {
    try {
      overlay = await startOverlayServer(handle.display, port);
      console.log(`overlay: ${overlay.url}`);
    } catch (error) {
      throw error;
    }
  }
  await handle.done;
  await stopRun?.();
  if (handle.exitCode !== 0) process.exitCode = handle.exitCode;
}

function requestedOverlayPort(args: string[]): number | null {
  const index = args.indexOf('--overlay');
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) return 8787;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--overlay port must be an integer from 0 to 65535');
  }
  return port;
}

function recordPath(): string | undefined {
  const index = process.argv.indexOf('--record');
  return index < 0 ? undefined : process.argv[index + 1];
}

async function restore(): Promise<void> {
  const { api } = await context();
  printJson(await restoreBaseline(api, baselineFile));
}

async function watch(): Promise<void> {
  const { helix, identity } = await context();
  const secondsIndex = process.argv.indexOf('--seconds');
  const seconds = secondsIndex >= 0 ? Number(process.argv[secondsIndex + 1]) : 30;
  eventSub = new EventSub(helix, identity.user_id, (event) => {
    printJson({ type: event.type });
  });
  await eventSub.connect();
  setTimeout(() => {
    eventSub?.close();
    process.exit(0);
  }, seconds * 1000).unref();
}

async function loadtest(args: string[]): Promise<void> {
  const rate = Number(optionValue(args, '--rate') ?? '0.5');
  const burst = Number(optionValue(args, '--burst') ?? '90');
  const taper = Number(optionValue(args, '--taper') ?? '30');
  const plan = parseLoadtestRate(rate, burst, taper);
  const directory = statePath('accounts');
  const names = await accountNames(directory);
  if (names.length === 0) {
    throw new Error(`No account files exist in ${directory}`);
  }
  const requestedText = optionValue(args, '--accounts');
  const requested = requestedText?.split(',').map((item) => item.trim()).filter(Boolean);
  const selected = requested ?? names;
  if (requested && requested.some((name) =>
    !names.some((candidate) => candidate.toLowerCase() === name.toLowerCase())
  )) {
    throw new Error('One or more requested account files were not found');
  }
  const channelValue = process.env.TWITCH_CHANNEL_LOGIN ?? '';
  if (selected.some((name) => name.toLowerCase() === channelValue.toLowerCase())) {
    throw new Error('The broadcaster cannot be used as a load-test account');
  }
  const lines = await loadLines();
  const { login: channelLogin, clientId } = config();
  if (args.includes('--dry')) {
    printLoadtestPlan(
      selected,
      plan.rate,
      plan.rate * selected.length,
      plan.burstSeconds,
      plan.taperSeconds,
      channelLogin,
      lines.length,
    );
    return;
  }
  const mainContext = await context();
  const accounts = await loadAccounts({
    directory,
    clientId,
    clientSecret: process.env.TWITCH_CLIENT_SECRET,
    broadcasterLogin: channelLogin,
    requestedLogins: requested,
    onSkip: (name, reason) => console.log(`skipping ${name}: ${reason}`),
  });
  printLoadtestPlan(
    accounts.map((account) => account.login),
    plan.rate,
    plan.rate * accounts.length,
    plan.burstSeconds,
    plan.taperSeconds,
    channelLogin,
    lines.length,
  );
  loadtestAbort = new AbortController();
  try {
    await runLoadtest({
      accounts,
      broadcasterId: mainContext.identity.user_id,
      channelLogin,
      stateDirectory: stateDirectory(),
      lines,
      rate: plan,
      signal: loadtestAbort.signal,
    });
  } finally {
    loadtestAbort = undefined;
  }
}

async function accountNames(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -5)).sort();
}

async function loadLines(): Promise<string[]> {
  const lines = (await readFile('loadtest/lines.txt', 'utf8'))
    .split(/\r?\n/).filter(Boolean);
  if (lines.length < 40 || lines.some((line) => line.length + 12 > 120)) {
    throw new Error('loadtest/lines.txt needs 40 lines under 120 characters each');
  }
  return lines;
}

function printLoadtestPlan(
  accounts: string[],
  rate: number,
  totalRate: number,
  burst: number,
  taper: number,
  channel: string,
  lineCount: number,
): void {
  console.log('LOAD TEST PLAN');
  console.log(`accounts: ${accounts.join(', ')}`);
  console.log(`rate per account: ${rate}/s; total planned rate: ${totalRate}/s`);
  console.log(`burst: ${burst}s; taper: ${taper}s; channel: ${channel}`);
  console.log(`scripted lines: ${lineCount}; prefix: [load test]`);
}

process.once('SIGINT', () => {
  if (loadtestAbort) {
    loadtestAbort.abort();
    return;
  }
  void (async () => {
    await stopRun?.();
    eventSub?.close();
    process.exit(130);
  })();
});
process.once('SIGTERM', () => {
  if (loadtestAbort) {
    loadtestAbort.abort();
    return;
  }
  void (async () => {
    await stopRun?.();
    eventSub?.close();
    process.exit(143);
  })();
});

try {
  const command = process.argv[2];
  if (command === 'login') await login();
  else if (command === 'probe') await probe();
  else if (command === 'restore') await restore();
  else if (command === 'watch') await watch();
  else if (command === 'run') await run();
  else if (command === 'replay') {
    const { replayCommand } = await import('./sim/command.ts');
    await replayCommand(process.argv.slice(3));
  }
  else if (command === 'loadtest') await loadtest(process.argv.slice(3));
  else if (command === 'report') {
    const { reportCommand } = await import('./report/command.ts');
    await reportCommand(process.argv.slice(3));
  }
  else {
    throw new Error(
      'Usage: node src/cli.ts <login|probe|watch|restore|run|replay|loadtest|report>',
    );
  }
} catch (error) {
  await stopRun?.();
  eventSub?.close();
  console.error(error instanceof Error ? error.message : 'Undertow failed');
  process.exitCode = 1;
}
