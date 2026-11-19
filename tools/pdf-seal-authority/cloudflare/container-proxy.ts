import { DurableObject } from 'cloudflare:workers';
import { unavailable } from './security';

const containerPort = 8080;
const idleMilliseconds = 60_000;

export abstract class SealContainer<Environment> extends DurableObject<Environment> {
	protected abstract readonly enableInternet: boolean;
	protected readonly readinessTimeoutMs: number = 10_000;
	protected abstract containerEnvironment(): Record<string, string>;

	async proxy(request: Request): Promise<Response> {
		const container = this.ctx.container;
		if (container === undefined) return unavailable(503);
		try {
			if (!container.running) {
				container.start({
					image: container.images.base,
					enableInternet: this.enableInternet,
					env: this.containerEnvironment()
				});
			}
			await container.setInactivityTimeout(idleMilliseconds);
			const port = container.getTcpPort(containerPort);
			if (!(await ready(port, this.readinessTimeoutMs))) return unavailable(503);
			const { pathname } = new URL(request.url);
			// Wait for the health check before sending the input. A lost sign
			// response remains ambiguous, so a submitted request is never retried.
			return await port.fetch(new Request(`http://container${pathname}`, request));
		} catch {
			return unavailable(503);
		}
	}
}

async function ready(port: Fetcher, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	do {
		try {
			const response = await port.fetch('http://container/healthz', {
				signal: AbortSignal.timeout(1_000)
			});
			const ok = response.ok;
			await response.body?.cancel();
			if (ok) return true;
		} catch {
			// Starting containers can refuse a health probe before the port is ready.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	} while (Date.now() < deadline);
	return false;
}
