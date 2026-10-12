import { describe, expect, it, vi } from 'vitest';
import type { InstanceCallerContext, InstanceMemberMetadata } from '$lib/ports/instance-store';
import {
	getRequestCallerContext,
	type RequestCallerContextLocals
} from './request-caller-membership';

const NOW: string = '2026-09-14T00:00:00.000Z';

function activeOwner(): InstanceMemberMetadata {
	return { userId: 'user-1', role: 'owner', status: 'active', createdAt: NOW, updatedAt: NOW };
}

function context(member: InstanceMemberMetadata | null = activeOwner()): InstanceCallerContext {
	return { bootstrapped: true, member };
}

describe('getRequestCallerContext', () => {
	it('resolves once per (request, caller) pair, sharing the same read between a hook and the root layout', async () => {
		const requestKey: RequestCallerContextLocals = {};
		const resolve = vi.fn(async (): Promise<InstanceCallerContext> => context());

		const fromHook: InstanceCallerContext = await getRequestCallerContext(
			requestKey,
			'user-1',
			resolve
		);
		const fromLayout: InstanceCallerContext = await getRequestCallerContext(
			requestKey,
			'user-1',
			resolve
		);

		expect(fromLayout).toBe(fromHook);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('shares one in-flight read between concurrent callers before it has settled', async () => {
		const requestKey: RequestCallerContextLocals = {};
		const resolve = vi.fn(
			(): Promise<InstanceCallerContext> =>
				new Promise((resolvePromise) => {
					setTimeout(() => resolvePromise(context()), 0);
				})
		);

		const [a, b]: InstanceCallerContext[] = await Promise.all([
			getRequestCallerContext(requestKey, 'user-1', resolve),
			getRequestCallerContext(requestKey, 'user-1', resolve)
		]);

		expect(a).toBe(b);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('keeps separate entries for different callers within the same request', async () => {
		const requestKey: RequestCallerContextLocals = {};
		const resolveOwner = vi.fn(async (): Promise<InstanceCallerContext> => context());
		const resolveNonMember = vi.fn(async (): Promise<InstanceCallerContext> => context(null));

		const owner: InstanceCallerContext = await getRequestCallerContext(
			requestKey,
			'user-1',
			resolveOwner
		);
		const nonMember: InstanceCallerContext = await getRequestCallerContext(
			requestKey,
			'user-2',
			resolveNonMember
		);

		expect(owner.member).not.toBeNull();
		expect(nonMember.member).toBeNull();
		expect(resolveOwner).toHaveBeenCalledTimes(1);
		expect(resolveNonMember).toHaveBeenCalledTimes(1);
	});

	it('never shares a cached read across different requests, even for the same caller id', async () => {
		const resolveFirstRequest = vi.fn(async (): Promise<InstanceCallerContext> => context());
		const resolveSecondRequest = vi.fn(async (): Promise<InstanceCallerContext> => context(null));

		const first: InstanceCallerContext = await getRequestCallerContext(
			{},
			'user-1',
			resolveFirstRequest
		);
		const second: InstanceCallerContext = await getRequestCallerContext(
			{},
			'user-1',
			resolveSecondRequest
		);

		expect(first.member).not.toBeNull();
		expect(second.member).toBeNull();
		expect(resolveFirstRequest).toHaveBeenCalledTimes(1);
		expect(resolveSecondRequest).toHaveBeenCalledTimes(1);
	});

	it('revalidates on the next request instead of reusing a snapshot from before a revocation', async () => {
		const callerId: string = 'user-1';
		const beforeRevocation = vi.fn(async (): Promise<InstanceCallerContext> => context());
		const afterRevocation = vi.fn(async (): Promise<InstanceCallerContext> =>
			context({ ...activeOwner(), status: 'suspended' })
		);

		const stillActive: InstanceCallerContext = await getRequestCallerContext(
			{},
			callerId,
			beforeRevocation
		);
		const nowSuspended: InstanceCallerContext = await getRequestCallerContext(
			{},
			callerId,
			afterRevocation
		);

		expect(stillActive.member?.status).toBe('active');
		expect(nowSuspended.member?.status).toBe('suspended');
	});

	it('caches a rejection the same way it caches a success, so every reader observes the same failure without a silent retry', async () => {
		const requestKey: RequestCallerContextLocals = {};
		const resolve = vi.fn(async (): Promise<InstanceCallerContext> => {
			throw new Error('instance membership unavailable');
		});

		await expect(getRequestCallerContext(requestKey, 'user-1', resolve)).rejects.toThrow(
			'instance membership unavailable'
		);
		await expect(getRequestCallerContext(requestKey, 'user-1', resolve)).rejects.toThrow(
			'instance membership unavailable'
		);

		expect(resolve).toHaveBeenCalledTimes(1);
	});

	it('shares a synchronously thrown resolver failure without retrying it', async () => {
		const locals: RequestCallerContextLocals = {};
		const resolve = vi.fn((): Promise<InstanceCallerContext> => {
			throw new Error('membership unavailable');
		});
		const first = getRequestCallerContext(locals, 'user-1', resolve);
		const second = getRequestCallerContext(locals, 'user-1', resolve);
		expect(second).toBe(first);
		await expect(first).rejects.toThrow('membership unavailable');
		expect(resolve).toHaveBeenCalledTimes(1);
	});
});
