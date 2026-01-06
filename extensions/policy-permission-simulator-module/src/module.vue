<template>
	<private-view title="Policy/Permission Simulator">
		<div class="layout">
			<div class="form">
				<div class="row">
					<div class="field">
						<div class="label">Mode</div>
						<VSelect v-model="mode" :items="modeItems" />
					</div>
					<div class="field">
						<div class="label">Collection</div>
						<VSelect v-model="collection" :items="collectionItems" :placeholder="'Select a collection'" />
					</div>
				</div>

				<div class="row" v-if="mode === 'user'">
					<div class="field">
						<div class="label">User ID</div>
						<VSelect v-model="userId" :items="userItems" :placeholder="'Select a user (optional)'"></VSelect>
						<VInput v-model="userId" placeholder="directus_users.id (uuid)" />
						<div v-if="usersLoadError" class="hint">{{ usersLoadError }}</div>
					</div>
					<div class="field">
						<div class="label">Role ID (optional)</div>
						<VSelect v-model="roleId" :items="roleItems" :placeholder="'Select a role (optional)'"></VSelect>
						<VInput v-model="roleId" placeholder="directus_roles.id (uuid)" />
						<div v-if="rolesLoadError" class="hint">{{ rolesLoadError }}</div>
					</div>
				</div>

				<div class="row" v-if="mode === 'role'">
					<div class="field">
						<div class="label">Role ID</div>
						<VSelect v-model="roleId" :items="roleItems" :placeholder="'Select a role'"></VSelect>
						<VInput v-model="roleId" placeholder="directus_roles.id (uuid)" />
						<div v-if="rolesLoadError" class="hint">{{ rolesLoadError }}</div>
					</div>
					<div class="field"></div>
				</div>

				<div class="row">
					<div class="field full">
						<div class="label">Query (JSON)</div>
						<VTextarea v-model="queryText" rows="8" />
						<div class="hint">Example: { "fields": ["*"], "limit": 1 }</div>
					</div>
				</div>

				<div class="row actions">
					<VButton :loading="loading" :disabled="!canSimulate" @click="simulate">Simulate</VButton>
					<VButton secondary :disabled="loading" @click="reset">Reset</VButton>
				</div>

				<VNotice v-if="error" type="danger">{{ error }}</VNotice>
				<VNotice v-if="warnings.length" type="warning">
					<div v-for="w in warnings" :key="w">{{ w }}</div>
				</VNotice>
			</div>

			<div class="output">
				<div class="label">Result</div>
				<VueJsonPretty
					:data="result"
					:deep="2"
					:showLength="true"
					:showLine="false"
					:showLineNumber="false"
					:highlight-selected-node="false"
				/>
			</div>
		</div>
	</private-view>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import VueJsonPretty from 'vue-json-pretty';
import 'vue-json-pretty/lib/styles.css';

type Mode = 'requester' | 'user' | 'role' | 'public';

type DirectusItemsQuery = {
	fields?: string[];
	limit?: number;
	[key: string]: unknown;
};

type SimulateRequestPayload = {
	mode: Mode;
	collection: string;
	query: DirectusItemsQuery;
	includeRequester: boolean;
	userId?: string;
	roleId?: string;
};

type SimulationHint = {
	field: string;
	type: 'missing' | 'null';
	note: string;
};

type SimulateResponse = {
	mode: Mode;
	collection: string;
	query: DirectusItemsQuery;
	warnings: string[];
	simulated: { items: unknown[] };
	requester?: { items: unknown[] };
	hints: SimulationHint[];
};

const api = useApi();
const { useCollectionsStore } = useStores();
const collectionsStore = useCollectionsStore();

onMounted(async () => {
	try {
		await collectionsStore?.hydrate?.();
	} catch {
		// no-op
	}

	// Best-effort preload for user/role dropdowns.
	void loadRoles();
	void loadUsers();
});

const mode = ref<Mode>('requester');
const collection = ref<string>('');
const userId = ref<string>('');
const roleId = ref<string>('');
const queryText = ref<string>('{\n  "fields": ["*"],\n  "limit": 1\n}');

const users = ref<Array<{ id: string; email?: string | null; first_name?: string | null; last_name?: string | null }>>([]);
const roles = ref<Array<{ id: string; name?: string | null }>>([]);
const usersLoadError = ref<string>('');
const rolesLoadError = ref<string>('');

const loading = ref(false);
const error = ref<string>('');
const warnings = ref<string[]>([]);
const result = ref<SimulateResponse | null>(null);

const modeItems = [
	{ text: 'Requester (me)', value: 'requester' },
	{ text: 'User', value: 'user' },
	{ text: 'Role (approx)', value: 'role' },
	{ text: 'Public', value: 'public' },
];

function isRefLike<T = unknown>(value: unknown): value is { value: T } {
	return !!value && typeof value === 'object' && 'value' in (value as Record<string, unknown>);
}

function unwrapMaybeRef<T = unknown>(value: unknown): T | unknown {
	if (isRefLike<T>(value)) return value.value;
	return value;
}

function normalizeCollectionList(value: unknown): unknown[] {
	const unwrapped = unwrapMaybeRef(value);
	if (Array.isArray(unwrapped)) return unwrapped;
	if (unwrapped && typeof unwrapped === 'object') return Object.values(unwrapped);
	return [];
}

function formatUserLabel(u: { id: string; email?: string | null; first_name?: string | null; last_name?: string | null }): string {
	const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
	if (u.email) return name ? `${u.email} (${name})` : u.email;
	return name || u.id;
}

async function loadUsers() {
	usersLoadError.value = '';
	try {
		const res = await api.get('/users', {
			params: {
				limit: 100,
				sort: 'email',
				fields: ['id', 'email', 'first_name', 'last_name'],
			},
		});
		users.value = (res as any)?.data?.data ?? [];
	} catch (err: any) {
		usersLoadError.value = err.response?.data?.errors?.[0]?.message ?? err.message;
	}
}

async function loadRoles() {
	rolesLoadError.value = '';
	try {
		const res = await api.get('/roles', {
			params: {
				limit: 100,
				sort: 'name',
				fields: ['id', 'name'],
			},
		});
		roles.value = (res as any)?.data?.data ?? [];
	} catch (err: any) {
		rolesLoadError.value = err.response?.data?.errors?.[0]?.message ?? err.message;
	}
}

const collectionItems = computed(() => {
	const list =
		normalizeCollectionList(collectionsStore.visibleCollections) ||
		normalizeCollectionList(collectionsStore.collections);
	return (list ?? [])
		.filter((c: unknown) => !!c && typeof c === 'object' && 'collection' in (c as Record<string, unknown>))
		.map((c: unknown) => {
			const collection = (c as Record<string, unknown>).collection;
			return { text: String(collection), value: String(collection) };
		});
});

const userItems = computed(() =>
	(users.value ?? []).map((u) => ({ text: formatUserLabel(u), value: u.id }))
);

const roleItems = computed(() =>
	(roles.value ?? []).map((r) => ({ text: r.name ?? r.id, value: r.id }))
);

const canSimulate = computed(() => {
	if (!collection.value) return false;
	if (mode.value === 'user') return !!userId.value;
	if (mode.value === 'role') return !!roleId.value;
	return true;
});

function reset() {
	error.value = '';
	warnings.value = [];
	result.value = null;
}

async function simulate() {
	error.value = '';
	warnings.value = [];
	result.value = null;

	let query: DirectusItemsQuery = {};
	try {
		query = (queryText.value?.trim() ? (JSON.parse(queryText.value) as DirectusItemsQuery) : {}) ?? {};
	} catch (e: unknown) {
		const err = e as any;
		error.value = `Query JSON invalid: ${err?.message ?? String(err)}`;
		return;
	}

	loading.value = true;
	try {
		const payload: SimulateRequestPayload = {
			mode: mode.value,
			collection: collection.value,
			query,
			includeRequester: true,
			userId: mode.value === 'user' ? userId.value : undefined,
			roleId: mode.value === 'role' || mode.value === 'user' ? roleId.value || undefined : undefined,
		};

		const response = await api.post('/policy-simulator-be/simulate', payload);
		const data = (response as any)?.data as SimulateResponse;
		result.value = data;
		warnings.value = data?.warnings ?? [];
	} catch (e: unknown) {
		const err = e as any;
		const message = err?.response?.data?.errors?.[0]?.message ?? err?.message ?? String(err);
		error.value = message;
	} finally {
		loading.value = false;
	}
}
</script>

<style scoped>
.layout {
	display: grid;
	grid-template-columns: 420px 1fr;
	gap: 16px;
	align-items: start;
}

.form,
.output {
	background: var(--theme--module-background);
	border: 1px solid var(--theme--border-normal);
	border-radius: var(--theme--border-radius);
	padding: 16px;
}

.row {
	display: grid;
	grid-template-columns: 1fr 1fr;
	gap: 12px;
	margin-bottom: 12px;
}

.row.actions {
	grid-template-columns: auto auto;
	justify-content: start;
	gap: 8px;
}

.field.full {
	grid-column: 1 / -1;
}

.label {
	font-size: 12px;
	color: var(--theme--foreground-subdued);
	margin-bottom: 6px;
}

.hint {
	margin-top: 6px;
	font-size: 12px;
	color: var(--theme--foreground-subdued);
}

@media (max-width: 1100px) {
	.layout {
		grid-template-columns: 1fr;
	}
}
</style>
