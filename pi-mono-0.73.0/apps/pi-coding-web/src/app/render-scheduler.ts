export type RenderFrameScheduler = (callback: () => void) => void;

export function createCoalescedRenderScheduler(
	renderNow: () => void,
	scheduleFrame: RenderFrameScheduler = scheduleNextFrame,
): () => void {
	let scheduled = false;
	return () => {
		if (scheduled) return;
		scheduled = true;
		scheduleFrame(() => {
			scheduled = false;
			renderNow();
		});
	};
}

function scheduleNextFrame(callback: () => void): void {
	if (typeof globalThis.requestAnimationFrame === "function") {
		globalThis.requestAnimationFrame(() => callback());
		return;
	}
	setTimeout(callback, 0);
}
