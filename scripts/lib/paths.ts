import { homedir } from 'node:os';
import { join } from 'node:path';

/** Results home: PITCREW_HOME, else <user Documents>/Pit Crew. */
export function homeDir(): string {
  return process.env.PITCREW_HOME || join(homedir(), 'Documents', 'Pit Crew');
}

/** Config (credentials): PITCREW_CONFIG_DIR, else %APPDATA%\pitcrew, else ~/.config/pitcrew. */
export function configDir(): string {
  if (process.env.PITCREW_CONFIG_DIR) return process.env.PITCREW_CONFIG_DIR;
  if (process.platform === 'win32' && process.env.APPDATA) return join(process.env.APPDATA, 'pitcrew');
  return join(homedir(), '.config', 'pitcrew');
}

export function siteDir(host: string): string {
  return join(homeDir(), 'sites', host);
}

export function runDir(host: string, date: string): string {
  return join(siteDir(host), 'runs', date);
}
