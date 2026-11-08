// Postgres for the Deluxe Drive server on Vercel.
//
// The hub (worker/hub.js) was written for SQLite: it calls
// sql.exec(query, ...params) with ? placeholders and reads .toArray(). This
// gives it the same shape over a Postgres pool, so the same server code runs
// on Cloudflare (Durable Object SQLite) and on Vercel (Postgres from Neon or
// any other provider, through DATABASE_URL or POSTGRES_URL).
import pg from 'pg';

// Sizes and times are BIGINT; read them back as numbers, not strings.
pg.types.setTypeParser(20, (value) => Number(value));

export function toPostgres(query) {
  let index = 0;
  let text = query.replace(/\?/g, () => `$${++index}`);
  if (/^\s*CREATE TABLE/i.test(text)) {
    text = text.replace(/\bBLOB\b/g, 'BYTEA').replace(/\bINTEGER\b/g, 'BIGINT');
  }
  if (/^\s*ALTER TABLE .* ADD COLUMN /i.test(text)) {
    text = text.replace(/ADD COLUMN /i, 'ADD COLUMN IF NOT EXISTS ');
  }
  return text;
}

function toParam(value) {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return value;
}

export class PgSql {
  constructor(connectionString) {
    this.pool = new pg.Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
    // A dropped idle connection must not crash the function.
    this.pool.on('error', (error) => console.error('Postgres pool error:', error.message));
  }

  async exec(query, ...params) {
    const result = await this.pool.query(toPostgres(query), params.map(toParam));
    const rows = result.rows || [];
    return { toArray: () => rows };
  }

  end() {
    return this.pool.end();
  }
}
