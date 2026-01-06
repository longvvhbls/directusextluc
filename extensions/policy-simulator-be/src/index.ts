import { defineEndpoint } from '@directus/extensions-sdk';
import { createError } from '@directus/errors';
import type { Accountability as DirectusAccountability, Query } from '@directus/types';

type SimulationMode = 'requester' | 'user' | 'role' | 'public';

type DirectusItemsQuery = Query;

type DirectusRequest = {
	id?: string;
	accountability?: DirectusAccountability;
	body?: unknown;
	headers?: Record<string, unknown>;
};

type DirectusErrorLike = {
	message: string;
	extensions?: {
		reason?: unknown;
		[key: string]: unknown;
	};
};

type SimulateRequestBody = {
	mode: SimulationMode;
	collection: string;
	query?: unknown;
	includeRequester?: boolean;
	userId?: string;
	roleId?: string;
};

const ForbiddenError = createError('FORBIDDEN', 'Admin access required.', 403);
const BadRequestError = createError('BAD_REQUEST', 'Invalid request.', 400);

function safeJson(value: unknown, maxLength = 4000): string {
	try {
		const str = JSON.stringify(value);
		if (typeof str !== 'string') return String(value);
		return str.length > maxLength ? str.slice(0, maxLength) + '…' : str;
	} catch {
		return '[unserializable]';
	}
}

function parseJsonIfNeeded(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	return JSON.parse(trimmed);
}

function getFirstItem<T>(items: T[]): T | null {
	return items.length > 0 ? items[0]! : null;
}

function buildHints(requesterItem: unknown | null, simulatedItem: unknown | null) {
	if (!requesterItem || typeof requesterItem !== 'object') return [];
	const requester = requesterItem as Record<string, unknown>;

	if (!simulatedItem || typeof simulatedItem !== 'object') {
		return Object.keys(requester).map((key) => ({
			field: key,
			type: 'missing',
			note: 'Field not returned for simulated context (may be restricted by permissions or query).',
		}));
	}

	const simulated = simulatedItem as Record<string, unknown>;

	const hints: Array<{ field: string; type: 'missing' | 'null'; note: string }> = [];
	for (const key of Object.keys(requester)) {
		if (!(key in simulated)) {
			hints.push({
				field: key,
				type: 'missing',
				note: 'Missing in simulated response (often indicates field/relational access restriction).',
			});
			continue;
		}

		if (simulated[key] === null && requester[key] !== null) {
			hints.push({
				field: key,
				type: 'null',
				note: 'Returned as null in simulated response while requester sees a value (often indicates field-level restriction).',
			});
		}
	}

	return hints;
}

function buildSimulatedAccountability(
	base: DirectusAccountability,
	overrides: { user?: string | null; role?: string | null; admin?: boolean; app?: boolean }
): DirectusAccountability {
	const next: DirectusAccountability = { ...(base ?? ({} as DirectusAccountability)) };

	if ('user' in overrides) next.user = overrides.user ?? null;
	if ('role' in overrides) next.role = overrides.role ?? null;
	if ('admin' in overrides) next.admin = overrides.admin ?? false;
	if ('app' in overrides) next.app = overrides.app ?? true;

	// Ensure roles is an array
	if (next.role) next.roles = [next.role];
	else if (!Array.isArray(next.roles)) next.roles = [];

	return next;
}

function extractForbiddenFields(reason: string): string[] {
	if (typeof reason !== 'string') return [];

	// Example reason values:
	// - You don't have permission to access field "secret_note" in collection "posts" ...
	// - You don't have permission to access fields "secret_note", "date_created" in collection "posts" ...
	const out: string[] = [];

	// Multi-field format: capture the quoted list before "in collection"
	const multi = reason.match(/access fields?\s+((?:"[^"]+"\s*,\s*)*"[^"]+")\s+in collection/i);
	if (multi?.[1]) {
		const list = multi[1];
		for (const m of list.matchAll(/"([^"]+)"/g)) {
			const field = m?.[1];
			if (field && !out.includes(field)) out.push(field);
		}
		return out;
	}

	// Single-field format: access field "x"
	for (const m of reason.matchAll(/access field\s+"([^"]+)"/gi)) {
		const field = m?.[1];
		if (field && !out.includes(field)) out.push(field);
	}

	return out;
}

function stripFieldsFromQuery(
	query: DirectusItemsQuery,
	forbiddenFields: string[]
): { nextQuery: DirectusItemsQuery; removedFields: string[]; removedWildcard: boolean } {
	if (!query || typeof query !== 'object') return { nextQuery: query, removedFields: [], removedWildcard: false };
	const q = query;
	if (!Array.isArray(q.fields)) return { nextQuery: query, removedFields: [], removedWildcard: false };
	if (!forbiddenFields.length) return { nextQuery: query, removedFields: [], removedWildcard: false };

	const originalFields = q.fields;
	let nextFields = [...originalFields];
	let removedWildcard = false;

	// If query requests everything, we can only help if there are other explicit fields to fall back to.
	if (nextFields.includes('*')) {
		const withoutWildcard = nextFields.filter((f) => f !== '*');
		if (withoutWildcard.length === 0) {
			return { nextQuery: query, removedFields: [], removedWildcard: false };
		}
		nextFields = withoutWildcard;
		removedWildcard = true;
	}

	const removedFields: string[] = [];
	for (const forbidden of forbiddenFields) {
		const beforeLen = nextFields.length;
		nextFields = nextFields.filter((f) => f !== forbidden);
		if (nextFields.length !== beforeLen) removedFields.push(forbidden);
	}

	if (removedWildcard || removedFields.length) {
		return { nextQuery: { ...(q ?? {}), fields: nextFields } as DirectusItemsQuery, removedFields, removedWildcard };
	}

	return { nextQuery: query, removedFields: [], removedWildcard: false };
}

export default defineEndpoint((router, context) => {
	const { services, getSchema, database, logger } = context;
	const { ItemsService } = services;

	router.get('/', (_req, res) => {
		res.json({
			name: 'Policy/Permission Simulator Endpoint',
			status: 'ok',
		});
	});

	router.post('/simulate', async (req: any, res, next) => {
		const startedAt = Date.now();
		const request = req as DirectusRequest;

		logger.info({
			id: request.id,
			accountability: request.accountability,
			body: request.body,
			headers: request.headers,
		}, 'permission-simulator: simulate request received');

		const requestId = request.id;

		try {
			if (!request.accountability?.admin) {
				logger.warn({ requestId }, 'permission-simulator: forbidden (admin required)');
				throw new ForbiddenError();
			}

			const requesterAccountability = request.accountability as DirectusAccountability;

			const body = (request.body ?? {}) as SimulateRequestBody;
			const mode = body.mode ?? 'requester';
			const collection = body.collection;
			const includeRequester = body.includeRequester ?? true;

			if (!collection || typeof collection !== 'string') throw new BadRequestError();
			if (!['requester', 'user', 'role', 'public'].includes(mode)) throw new BadRequestError();

			// Parse query
			let query: DirectusItemsQuery = {};
			try {
				query = (parseJsonIfNeeded(body.query) as DirectusItemsQuery) ?? {};
			} catch (_err) {
				logger.error(
					{ requestId, mode, collection, query: typeof body.query === 'string' ? body.query.slice(0, 500) : typeof body.query },
					'permission-simulator: invalid query JSON'
				);
				throw new BadRequestError();
			}

			logger.info(
				{
					requestId,
					mode,
					collection,
					includeRequester,
					userId: mode === 'user' ? body.userId : undefined,
					roleId: mode === 'role' || mode === 'user' ? body.roleId : undefined,
					query: safeJson(query),
				},
				'permission-simulator: simulate start'
			);

			const warnings: string[] = [];

			// === Build simulated accountability based on mode =====
			let simulatedAccountability: DirectusAccountability = requesterAccountability;

			if (mode === 'public') {
				simulatedAccountability = buildSimulatedAccountability(requesterAccountability, {
					user: null,
					role: null,
					admin: false,
					app: true,
				});
			}

			if (mode === 'role') {
				if (!body.roleId || typeof body.roleId !== 'string') {
					throw new BadRequestError();
				}
				simulatedAccountability = buildSimulatedAccountability(requesterAccountability, {
					user: null,
					role: body.roleId,
					admin: false,
					app: true,
				});
				warnings.push(
					"Role-only simulation can't evaluate $CURRENT_USER-dependent permission rules. Prefer mode 'user' for accurate results."
				);
			}

			if (mode === 'user') {
				if (!body.userId || typeof body.userId !== 'string') {
					throw new BadRequestError();
				}
				let resolvedRoleId: string | null = typeof body.roleId === 'string' ? body.roleId : null;
				let status: string | null = null;

				if (!resolvedRoleId) {
					const userRow = (await database('directus_users')
						.select(['role', 'status'])
						.where({ id: body.userId })
						.first()) as { role?: string | null; status?: string | null } | undefined;

					if (!userRow) throw new BadRequestError();
					resolvedRoleId = userRow.role ?? null;
					status = userRow.status ?? null;
				}

				if (!resolvedRoleId) {
					warnings.push('User has no role assigned; simulation may deny most access.');
				}

				if (status && status !== 'active') {
					warnings.push(`User status is '${status}'. In real requests, non-active users cannot authenticate.`);
				}

				simulatedAccountability = buildSimulatedAccountability(requesterAccountability, {
					user: body.userId,
					role: resolvedRoleId,
					admin: false,
					app: true,
				});
			}

			const schema = await getSchema();

			const simulatedService = new ItemsService(collection, {
				schema,
				accountability: simulatedAccountability,
			});

			// === Perform simulated query =====
			let simulatedItems: unknown[];
			try {
				simulatedItems = (await simulatedService.readByQuery(query)) as unknown[];
			} catch (err: unknown) {
				const e = err as DirectusErrorLike;
				logger.warn(
					{
						error: {
							message: e.message,
							extension: e.extensions,
						},
					},
					'permission-simulator: readByQuery failed, attempting single retry without forbidden fields'
				);

				const reason = (e.extensions?.reason ?? e.message) as string;
				const forbiddenFields = extractForbiddenFields(reason);
				logger.warn({ forbiddenFields }, 'permission-simulator: extracted forbidden fields from error');

				if (!forbiddenFields.length) throw err;
				const { nextQuery, removedFields, removedWildcard } = stripFieldsFromQuery(query, forbiddenFields);
				if (!removedFields.length && !removedWildcard) throw err;

				if (removedWildcard) {
					warnings.push(
						"Simulated context cannot access one or more fields while query.fields contains '*'. Retrying simulation with '*' removed (keeping explicit fields only)."
					);
				}

				if (removedFields.length) {
					warnings.push(
						`Simulated context cannot access field(s) ${removedFields.map((f) => `'${f}'`).join(', ')}. Retrying simulation with those fields removed from query.fields.`
					);
				}

				simulatedItems = (await simulatedService.readByQuery(nextQuery)) as unknown[];
			}

			logger.info({ requestId, simulatedItems }, 'permission-simulator: simulated query result');

			// === Perform requester query for creating hints =====
			let requesterItems: unknown[] = [];
			if (includeRequester) {
				const requesterService = new ItemsService(collection, {
					schema,
					accountability: requesterAccountability,
				});
				requesterItems = (await requesterService.readByQuery(query)) as unknown[];
			}

			// === Build hints =====
			const hints = includeRequester
				? buildHints(getFirstItem(requesterItems), getFirstItem(simulatedItems))
				: [];

			logger.info(
				{
					requestId,
					durationMs: Date.now() - startedAt,
					simulatedCount: simulatedItems.length,
					requesterCount: includeRequester ? requesterItems.length : undefined,
					hintsCount: hints.length,
					warningsCount: warnings.length,
				},
				'permission-simulator: simulate done'
			);


			// === Return response =====
			res.json({
				mode,
				collection,
				query,
				warnings,
				simulated: {
					items: simulatedItems,
				},
				...(includeRequester
					? {
						requester: {
							items: requesterItems,
						},
					}
					: {}),
				hints,
			});
		} catch (err: unknown) {
			const e = err as any;
			logger.error(
				{
					requestId,
					durationMs: Date.now() - startedAt,
					err: {
						message: e?.message,
						name: e?.name,
						code: e?.code,
						status: e?.status,
						stack: typeof e?.stack === 'string' ? e.stack.slice(0, 4000) : undefined,
					},
				},
				'permission-simulator: simulate error'
			);
			next(err);
		}
	});
});
