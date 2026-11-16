import type pg from 'pg';
import { normalizePermissionHost } from '../../domain/source-permission.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Persistence only: permission does not validate or perform a public fetch. */
export class SourcePermissionStore {
  constructor(private readonly pool: pg.Pool) {}

  async listSources() {
    const result = await this.pool.query<{ id: string; context_id: string; external_feed_id: string; title: string | null; permission_override: boolean | null }>(
      'select id, context_id, external_feed_id, title, permission_override from sources order by id',
    );
    return result.rows.map(row => ({ id: row.id, contextId: row.context_id, externalFeedId: row.external_feed_id, title: row.title, override: row.permission_override }));
  }

  async listHostRules() {
    return (await this.pool.query<{ host: string; allowed: boolean }>('select host, allowed from source_permission_host_rules order by host')).rows;
  }

  async setSourceOverride(sourceId: string, override: boolean | null): Promise<boolean> {
    if (override !== null && typeof override !== 'boolean') throw new Error('Invalid permission override');
    if (typeof sourceId !== 'string' || !uuid.test(sourceId)) return false;
    const result = await this.pool.query('update sources set permission_override = $2 where id = $1 returning id', [sourceId, override]);
    return result.rowCount === 1;
  }

  async upsertHostRule(host: string, allowed: boolean) {
    if (typeof allowed !== 'boolean') throw new Error('Invalid permission rule');
    const canonicalHost = normalizePermissionHost(host);
    await this.pool.query('insert into source_permission_host_rules (host, allowed) values ($1, $2) on conflict (host) do update set allowed = excluded.allowed', [canonicalHost, allowed]);
    return { host: canonicalHost, allowed };
  }

  /** Resolve the article's actual source in one statement; this does not validate public fetching. */
  async resolveForArticle(articleId: string, originalHostname: string): Promise<boolean> {
    if (typeof articleId !== 'string' || !uuid.test(articleId)) return false;
    let host: string;
    try { host = normalizePermissionHost(originalHostname); } catch { return false; }
    const result = await this.pool.query<{ allowed: boolean }>(
      'select coalesce(s.permission_override, r.allowed, false) as allowed from articles a left join sources s on s.id = a.source_id left join source_permission_host_rules r on r.host = $2 where a.id = $1',
      [articleId, host],
    );
    return result.rows[0]?.allowed ?? false;
  }

  /** Resolve only an exact host rule; source overrides never apply. */
  async resolveHost(host: string): Promise<boolean> {
    let canonicalHost: string;
    try { canonicalHost = normalizePermissionHost(host); } catch { return false; }
    const result = await this.pool.query<{ allowed: boolean }>('select allowed from source_permission_host_rules where host = $1', [canonicalHost]);
    return result.rows[0]?.allowed ?? false;
  }

  /** Null means source not found; invalid or absent hosts inherit false unless overridden. */
  async resolve(sourceId: string, host: string | null): Promise<boolean | null> {
    if (typeof sourceId !== 'string' || !uuid.test(sourceId)) return null;
    let canonicalHost: string | null = null;
    if (host !== null) {
      try { canonicalHost = normalizePermissionHost(host); } catch { /* fail closed */ }
    }
    const result = await this.pool.query<{ allowed: boolean }>(
      'select coalesce(s.permission_override, r.allowed, false) as allowed from sources s left join source_permission_host_rules r on r.host = $2 where s.id = $1',
      [sourceId, canonicalHost],
    );
    return result.rows[0]?.allowed ?? null;
  }
}
