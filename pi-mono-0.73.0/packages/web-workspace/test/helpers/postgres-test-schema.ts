import { randomUUID } from "node:crypto";
import pg from "pg";

export interface PostgresTestSchema {
	admin: pg.Pool;
	pool: pg.Pool;
	schema: string;
	close(): Promise<void>;
}

export async function createPostgresTestSchema(): Promise<PostgresTestSchema> {
	const url = process.env.PI_TEST_POSTGRES_URL;
	if (!url) throw new Error("PI_TEST_POSTGRES_URL is required for PostgreSQL schema integration tests");
	const schema = `pi_agent_v2_${randomUUID().replaceAll("-", "")}`;
	const admin = new pg.Pool({ connectionString: url, max: 2 });
	await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
	const pool = new pg.Pool({ connectionString: url, max: 4, options: `-c search_path=${schema}` });
	const clients = await Promise.all([pool.connect(), pool.connect()]);
	for (const client of clients) {
		try {
			const result = await client.query<{ current_schema: string }>("SELECT current_schema()");
			if (result.rows[0]?.current_schema !== schema) throw new Error("PostgreSQL test search_path isolation failed");
		} finally {
			client.release();
		}
	}
	return {
		admin,
		pool,
		schema,
		async close() {
			await pool.end();
			await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
			await admin.end();
		},
	};
}

function quoteIdentifier(value: string): string {
	return `"${value.replaceAll('"', '""')}"`;
}
