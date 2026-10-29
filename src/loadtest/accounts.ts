import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateStoredToken, type Tokens } from '../auth/auth.ts';
import { atomicJson, readJson } from '../util/files.ts';
import { Helix } from '../util/helix.ts';

export type LoadtestAccount = {
  login: string;
  userId: string;
  helix: Helix;
};

export type AccountLoadOptions = {
  directory: string;
  clientId: string;
  clientSecret?: string;
  broadcasterLogin: string;
  requestedLogins?: string[];
  fetcher?: typeof fetch;
  onSkip?: (login: string, reason: string) => void;
};

export async function loadAccounts(
  options: AccountLoadOptions,
): Promise<LoadtestAccount[]> {
  const entries = await readdir(options.directory, { withFileTypes: true })
    .catch(() => []);
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No account files exist in ${options.directory}`);
  }
  const requested = options.requestedLogins?.map((login) => login.toLowerCase());
  const selected = files.filter((entry) => {
    const login = entry.name.slice(0, -5).toLowerCase();
    return !requested || requested.includes(login);
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (requested && selected.length !== requested.length) {
    throw new Error('One or more requested account files were not found');
  }
  const accounts: LoadtestAccount[] = [];
  for (const entry of selected) {
    const path = join(options.directory, entry.name);
    const account = await loadAccount(path, entry.name, options);
    if (account) accounts.push(account);
  }
  if (accounts.length === 0) {
    throw new Error('No valid load-test accounts are available');
  }
  return accounts;
}

async function loadAccount(
  path: string,
  fileName: string,
  options: AccountLoadOptions,
): Promise<LoadtestAccount | null> {
  const fileLogin = fileName.slice(0, -5);
  if (fileLogin.toLowerCase() === options.broadcasterLogin.toLowerCase()) {
    throw new Error('Broadcaster account file refused; use a plain team account');
  }
  try {
    const tokens = await readJson<Tokens>(path);
    const persist = (next: Tokens) => atomicJson(path, next);
    const { tokens: active, identity } = await validateStoredToken(
      tokens,
      options.clientId,
      fileLogin,
      persist,
      options.fetcher,
      options.clientSecret,
      ['user:write:chat'],
    );
    const helix = new Helix(options.clientId, active, persist, {
      fetcher: options.fetcher,
      clientSecret: options.clientSecret,
    });
    return { login: identity.login, userId: identity.user_id, helix };
  } catch {
    options.onSkip?.(fileLogin, 'token unavailable or refresh failed');
    return null;
  }
}
