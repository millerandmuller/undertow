import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson } from '../util/files.ts';
import { deviceLogin, type DeviceLoginOptions, type Tokens } from './auth.ts';

export type AccountLoginOptions = {
  clientId: string;
  broadcasterLogin: string;
  accountLogin: string;
  stateDirectory: string;
  device?: Omit<DeviceLoginOptions, 'scopes'>;
};

export async function loginAccount(options: AccountLoginOptions): Promise<Tokens> {
  const accountLogin = options.accountLogin;
  if (!/^[a-z0-9_]+$/i.test(accountLogin)) {
    throw new Error('Account login may contain only letters, numbers, and underscores');
  }
  if (accountLogin.toLowerCase() === options.broadcasterLogin.toLowerCase()) {
    throw new Error('The broadcaster cannot be used as a load-test account');
  }
  const directory = join(options.stateDirectory, 'accounts');
  const path = join(directory, `${accountLogin.toLowerCase()}.json`);
  return deviceLogin(
    options.clientId,
    accountLogin,
    async (tokens) => saveAccount(directory, path, tokens),
    { ...options.device, scopes: ['user:write:chat'] },
  );
}

async function saveAccount(directory: string, path: string, tokens: Tokens): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await atomicJson(path, tokens);
}
