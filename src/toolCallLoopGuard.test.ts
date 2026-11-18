import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	DEFAULT_TOOL_LOOP_WARN_AT,
	TOOL_LOOP_IDLE_RESET_MS,
	ToolCallLoopGuard,
	fingerprintToolCall,
	formatToolLoopAlertMessage,
} from './toolCallLoopGuard';

describe('toolCallLoopGuard', () => {
	it('fingerprints ignore JSON key order and whitespace', () => {
		const a = fingerprintToolCall('list_workflows', '{"owner":"ALc51","repo":"x"}');
		const b = fingerprintToolCall('list_workflows', '{ "repo" : "x" , "owner" : "ALc51" }');
		assert.equal(a, b);
		assert.notEqual(
			fingerprintToolCall('list_workflows', '{"owner":"ALc51"}'),
			fingerprintToolCall('get_workflow', '{"owner":"ALc51"}')
		);
	});

	it('alerts when streak reaches threshold and every multiple thereafter', () => {
		const guard = new ToolCallLoopGuard();
		const args = '{"owner":"o","repo":"r"}';
		const t = DEFAULT_TOOL_LOOP_WARN_AT;

		assert.equal(guard.record({ name: 'list', arguments: args, threshold: t }).shouldAlert, false);
		assert.equal(guard.record({ name: 'list', arguments: args, threshold: t }).shouldAlert, false);
		const third = guard.record({ name: 'list', arguments: args, threshold: t });
		assert.equal(third.shouldAlert, true);
		assert.equal(third.streak, 3);
		assert.ok(third.alert);
		assert.match(formatToolLoopAlertMessage(third.alert!), /连续相同 tool call ×3/);

		assert.equal(guard.record({ name: 'list', arguments: args, threshold: t }).shouldAlert, false);
		assert.equal(guard.record({ name: 'list', arguments: args, threshold: t }).shouldAlert, false);
		assert.equal(guard.record({ name: 'list', arguments: args, threshold: t }).shouldAlert, true);
		assert.equal(guard.getStreak(), 6);
	});

	it('resets streak when tool signature changes', () => {
		const guard = new ToolCallLoopGuard();
		guard.record({ name: 'a', arguments: '{}', threshold: 3 });
		guard.record({ name: 'a', arguments: '{}', threshold: 3 });
		const next = guard.record({ name: 'b', arguments: '{}', threshold: 3 });
		assert.equal(next.streak, 1);
		assert.equal(guard.getAlert(), undefined);
	});

	it('threshold 0 disables alerting but still tracks streak', () => {
		const guard = new ToolCallLoopGuard();
		for (let i = 0; i < 5; i++) {
			const r = guard.record({ name: 'x', arguments: '{}', threshold: 0 });
			assert.equal(r.shouldAlert, false);
			assert.equal(r.alert, undefined);
		}
		assert.equal(guard.getStreak(), 5);
	});

	it('noteNonToolTurn clears alert', () => {
		const guard = new ToolCallLoopGuard();
		const args = '{}';
		guard.record({ name: 'x', arguments: args, threshold: 2 });
		guard.record({ name: 'x', arguments: args, threshold: 2 });
		assert.ok(guard.getAlert());
		guard.noteNonToolTurn();
		assert.equal(guard.getStreak(), 0);
		assert.equal(guard.getAlert(), undefined);
	});

	it('idle timeout resets streak', () => {
		const guard = new ToolCallLoopGuard();
		const t0 = 1_000_000;
		guard.record({ name: 'x', arguments: '{}', threshold: 3, now: t0 });
		guard.record({ name: 'x', arguments: '{}', threshold: 3, now: t0 + 1 });
		const afterIdle = guard.record({
			name: 'x',
			arguments: '{}',
			threshold: 3,
			now: t0 + TOOL_LOOP_IDLE_RESET_MS + 2,
		});
		assert.equal(afterIdle.streak, 1);
	});
});
