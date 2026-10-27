import { deviceLogin, validateToken, type Tokens } from './auth/auth.ts';
import { chatSettings, probeWithRestore, restoreBaseline } from './actuator/settings.ts';
import { EventSub } from './eventsub/client.ts';
import { Helix } from './util/helix.ts';
import { atomicJson, readJson } from './util/files.ts';

const tokenFile = '.undertow/tokens.json';
const baselineFile = '.undertow/baseline.json';
let eventSub: EventSub | undefined;

function config(): { clientId: string; login: string } {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const login = process.env.TWITCH_CHANNEL_LOGIN;
  if (!clientId) throw new Error('TWITCH_CLIENT_ID is required');
  if (!login) throw new Error('TWITCH_CHANNEL_LOGIN is required');
  return { clientId, login };
}

async function context() {
  const { clientId, login } = config();
  const tokens = await readJson<Tokens>(tokenFile);
  const identity = await validateToken(tokens.access_token, clientId, login);
  Object.assign(tokens, identity);
  const helix = new Helix(
    clientId,
    tokens,
    (next) => atomicJson(tokenFile, next),
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
  const tokens = await deviceLogin(
    clientId,
    expectedLogin,
    (value) => atomicJson(tokenFile, value),
    { onCode: (code, uri) => console.log(`Open ${uri} and enter code ${code}`) },
  );
  console.log(`Validated ${tokens.login}; scopes: ${tokens.scope.join(', ')}`);
}

async function probe(): Promise<void> {
  if (!process.argv.includes('--yes')) {
    console.log(
      'Plan: validate token, save chat settings baseline, set slow mode to 10 seconds, ' +
        'read back, restore baseline, verify. Pass --yes to run.',
    );
    return;
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

process.once('SIGINT', () => {
  eventSub?.close();
  process.exit(130);
});
process.once('SIGTERM', () => {
  eventSub?.close();
  process.exit(143);
});

try {
  const command = process.argv[2];
  if (command === 'login') await login();
  else if (command === 'probe') await probe();
  else if (command === 'restore') await restore();
  else if (command === 'watch') await watch();
  else throw new Error('Usage: node src/cli.ts <login|probe|watch|restore>');
} catch (error) {
  eventSub?.close();
  console.error(error instanceof Error ? error.message : 'Undertow failed');
  process.exitCode = 1;
}
