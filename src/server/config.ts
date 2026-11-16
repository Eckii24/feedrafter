import { isIP } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { KarakeepClient } from './adapters/karakeep/client.js';

export interface AppConfig { databaseUrl: string; origin: string; host: string; port: number; trustedProxies: string[]; fresh?: { baseUrl: string; email: string; password: string }; karakeep?: { baseUrl: string; token: string } }
function value(env: NodeJS.ProcessEnv, name: string, fallback?: string): string {
  const v = env[name] ?? fallback;
  if (v === undefined || !v.trim() || v !== v.trim()) throw new Error(`Invalid ${name}`);
  return v;
}
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const databaseUrl = value(env, 'DATABASE_URL');
  const db = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(db.protocol) || !db.hostname || !db.pathname.slice(1)) throw new Error('Invalid DATABASE_URL');
  const originUrl = new URL(value(env, 'APP_ORIGIN'));
  if (!['http:', 'https:'].includes(originUrl.protocol) || originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash) throw new Error('Invalid APP_ORIGIN');
  const host = value(env, 'HOST', '127.0.0.1');
  const portText = value(env, 'PORT', '3000');
  if (!/^\d+$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) throw new Error('Invalid PORT');
  const trustedProxies = env.TRUSTED_PROXIES === undefined ? [] : value(env, 'TRUSTED_PROXIES').split(',');
  for (const address of trustedProxies) {
    const [ip, prefix, ...rest] = address.split('/');
    const version = isIP(ip ?? '');
    if (!version || rest.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (version === 4 ? 32 : 128)))) throw new Error('Invalid TRUSTED_PROXIES');
  }
  let fresh: AppConfig['fresh'];
  if (env.FRESHRSS_ENABLED !== undefined && !['true', 'false'].includes(env.FRESHRSS_ENABLED)) throw new Error('Invalid FRESHRSS_ENABLED');
  if (env.FRESHRSS_ENABLED === 'true') {
    const baseUrl = value(env, 'FRESHRSS_BASE_URL');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.pathname.replace(/\/$/, '').endsWith('/api/greader.php')) throw new Error('Invalid FRESHRSS_BASE_URL');
    if (env.FRESHRSS_API_PASSWORD !== undefined && env.FRESHRSS_API_PASSWORD_FILE !== undefined) throw new Error('Invalid FreshRSS secret configuration');
    let password: string;
    if (env.FRESHRSS_API_PASSWORD_FILE !== undefined) {
      const path = value(env, 'FRESHRSS_API_PASSWORD_FILE');
      if (!isAbsolute(path) || !statSync(path).isFile() || statSync(path).size > 16384) throw new Error('Invalid FreshRSS secret file');
      password = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
      if (!password || password !== password.trim()) throw new Error('Invalid FreshRSS secret file');
    } else password = value(env, 'FRESHRSS_API_PASSWORD');
    fresh = { baseUrl, email: value(env, 'FRESHRSS_EMAIL'), password };
  } else if (['FRESHRSS_BASE_URL', 'FRESHRSS_EMAIL', 'FRESHRSS_API_PASSWORD', 'FRESHRSS_API_PASSWORD_FILE'].some(k => env[k] !== undefined && !env[k]?.trim())) throw new Error('Invalid FreshRSS configuration');
  let karakeep: AppConfig['karakeep'];
  if (env.KARAKEEP_ENABLED !== undefined && !['true', 'false'].includes(env.KARAKEEP_ENABLED)) throw new Error('Invalid KARAKEEP_ENABLED');
  if (env.KARAKEEP_ENABLED === 'true') {
    if (env.KARAKEEP_TOKEN !== undefined && env.KARAKEEP_TOKEN_FILE !== undefined) throw new Error('Invalid Karakeep secret configuration');
    let token: string;
    if (env.KARAKEEP_TOKEN_FILE !== undefined) {
      const path = value(env, 'KARAKEEP_TOKEN_FILE');
      if (!isAbsolute(path) || !statSync(path).isFile() || statSync(path).size > 16384) throw new Error('Invalid Karakeep secret file');
      token = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } else token = value(env, 'KARAKEEP_TOKEN');
    karakeep = { baseUrl: value(env, 'KARAKEEP_BASE_URL'), token };
    new KarakeepClient(karakeep); // Validate exactly the authority and bearer syntax used by the client.
  }
  return { databaseUrl, origin: originUrl.origin, host, port: Number(portText), trustedProxies, ...(fresh ? { fresh } : {}), ...(karakeep ? { karakeep } : {}) };
}
