import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const args = parseArgs(process.argv.slice(2));
const dbFile = resolve(args.db || process.env.PI_LOG_DB || "data/logs/pi-diagnostics.sqlite");
if (!existsSync(dbFile)) {
	console.error(`PI diagnostics database not found: ${dbFile}`);
	process.exit(1);
}

const database = new DatabaseSync(dbFile, { readOnly: true });
const clauses = [];
const values = [];
addClause(clauses, values, "session_id", args.session);
addClause(clauses, values, "trace_id", args.trace);
addClause(clauses, values, "level", args.level);
addClause(clauses, values, "category", args.category);
addClause(clauses, values, "event_type", args.event);
const limit = clampLimit(Number(args.limit || 50));
values.push(limit);

const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
const rows = database
	.prepare(
		`SELECT id, timestamp, level, category, event_type, session_id, trace_id, provider, model, duration_ms, data_json
		FROM diagnostic_events
		${where}
		ORDER BY id DESC
		LIMIT ?`,
	)
	.all(...values);

for (const row of rows.reverse()) {
	const details = JSON.parse(String(row.data_json || "{}"));
	const prefix = [
		row.timestamp,
		String(row.level).toUpperCase().padEnd(5),
		`${row.category}.${row.event_type}`,
		row.session_id ? `session=${row.session_id}` : "",
		row.provider ? `provider=${row.provider}` : "",
		row.model ? `model=${row.model}` : "",
		row.duration_ms !== null ? `durationMs=${row.duration_ms}` : "",
	]
		.filter(Boolean)
		.join(" ");
	console.log(`${prefix}\n${JSON.stringify(details, null, 2)}`);
}

function parseArgs(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			result[key] = "true";
			continue;
		}
		result[key] = next;
		index += 1;
	}
	return result;
}

function addClause(clauses, values, column, value) {
	if (!value) return;
	clauses.push(`${column} = ?`);
	values.push(value);
}

function clampLimit(value) {
	if (!Number.isFinite(value)) return 50;
	return Math.min(500, Math.max(1, Math.round(value)));
}
