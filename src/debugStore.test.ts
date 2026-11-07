import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DebugStore, type ModelTurn } from './debugStore';

function createDummyTurn(id: string, status: ModelTurn['status'] = 'running'): ModelTurn {
	return {
		id,
		model: 'mimo-v2.6-flash',
		baseUrl: 'https://api.xiaomimimo.com/v1',
		created: Date.now(),
		status,
		requestOptions: {},
		messageCount: 1,
		messageSummary: 'user=1',
		messagesPreview: [],
		toolNames: [],
		toolCalls: [],
		responseTextPreview: '',
		thinkingTextPreview: '',
		textChars: 0,
		thinkingChars: 0,
	};
}

describe('debugStore', () => {
	it('upserts new turns and updates existing turns', () => {
		const store = new DebugStore(5);
		const turn1 = createDummyTurn('t1', 'running');
		store.upsert(turn1);

		assert.equal(store.list().length, 1);
		assert.equal(store.get('t1')?.status, 'running');

		const turn1Done: ModelTurn = {
			...turn1,
			status: 'success',
			durationMs: 500,
		};
		store.upsert(turn1Done);

		assert.equal(store.list().length, 1); // Not duplicated
		assert.equal(store.get('t1')?.status, 'success');
		assert.equal(store.get('t1')?.durationMs, 500);
	});

	it('respects capacity limit and evicts oldest turns', () => {
		const store = new DebugStore(3);
		store.upsert(createDummyTurn('t1'));
		store.upsert(createDummyTurn('t2'));
		store.upsert(createDummyTurn('t3'));
		assert.equal(store.list().length, 3);
		assert.ok(store.get('t1'));

		// Adding 4th should evict t1
		store.upsert(createDummyTurn('t4'));
		assert.equal(store.list().length, 3);
		assert.equal(store.get('t1'), undefined);
		assert.ok(store.get('t2'));
		assert.ok(store.get('t3'));
		assert.ok(store.get('t4'));
	});

	it('clear empties turns and index', () => {
		const store = new DebugStore(5);
		store.upsert(createDummyTurn('t1'));
		store.upsert(createDummyTurn('t2'));
		assert.equal(store.list().length, 2);

		store.clear();
		assert.equal(store.list().length, 0);
		assert.equal(store.get('t1'), undefined);
		assert.equal(store.get('t2'), undefined);
	});
});
