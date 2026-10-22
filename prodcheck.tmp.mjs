// TEMPORARY read-only production schema probe. Deleted immediately after use.
import { Pool } from '@neondatabase/serverless';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

try {
  const cols = await pool.query(
    `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_name = 'users'
      ORDER BY ordinal_position`,
  );
  console.log('users columns:');
  for (const row of cols.rows) {
    console.log(`  - ${row.column_name} (${row.data_type}, nullable=${row.is_nullable})`);
  }

  const idx = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'users' ORDER BY indexname`,
  );
  console.log('users indexes:', idx.rows.map((r) => r.indexname).join(', ') || '(none)');

  const migrations = await pool.query('SELECT id FROM schema_migrations ORDER BY id');
  console.log('migrations:', migrations.rows.map((r) => r.id).join(', '));

  const counts = await pool.query('SELECT count(*)::int AS n FROM users');
  console.log('user rows:', counts.rows[0].n);
} finally {
  await pool.end();
}